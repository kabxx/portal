/**
 * Windows Job Object wrapper using koffi FFI.
 *
 * On Windows: creates a Job Object with KILL_ON_JOB_CLOSE.
 * When the Node.js process exits (normally, crash, or killed),
 * the OS closes all handles including the Job, which triggers
 * KILL_ON_JOB_CLOSE and kills all processes in the Job.
 *
 * On non-Windows: no-op stubs.
 */

import koffi from 'koffi'
import type { LibraryHandle } from 'koffi'

const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9

// JOBOBJECT_EXTENDED_LIMIT_INFORMATION offset of LimitFlags (64-bit):
//   BasicLimitInformation.PerProcessUserTimeLimit  (8)  @ 0
//   BasicLimitInformation.PerJobUserTimeLimit      (8)  @ 8
//   BasicLimitInformation.LimitFlags               (4)  @ 16
//   ...padding + IoInfo + MemoryLimit fields...    total 144 bytes
const LIMIT_FLAGS_OFFSET = 16
const JOB_EXTENDED_INFO_SIZE = 144
const JOB_BASIC_ACCOUNTING_INFO_SIZE = 48
const ACTIVE_PROCESSES_OFFSET = 40

const isWin32 = process.platform === 'win32'

let kernel32: LibraryHandle | null = null

let _CreateJobObjectW: ((attr: null, name: string | null) => number) | null =
  null
let _SetInformationJobObject:
  | ((hJob: number, type_: number, info: Buffer, size: number) => boolean)
  | null = null
let _AssignProcessToJobObject:
  ((hJob: number, hProcess: number) => boolean) | null = null
let _IsProcessInJob:
  ((hProcess: number, hJob: number, result: Buffer) => boolean) | null = null
let _TerminateJobObject: ((hJob: number, exitCode: number) => boolean) | null =
  null
let _QueryInformationJobObject:
  | ((
      hJob: number,
      type_: number,
      info: Buffer,
      size: number,
      returnedLength: null
    ) => boolean)
  | null = null
let _OpenProcess:
  ((access: number, inherit: boolean, pid: number) => number) | null = null
let _CloseHandle: ((handle: number) => boolean) | null = null

function ensureLoaded() {
  if (kernel32 !== null) return
  if (!isWin32) return

  kernel32 = koffi.load('kernel32.dll')

  _CreateJobObjectW = kernel32.func('CreateJobObjectW', 'size_t', [
    'void *',
    'str',
  ])

  _SetInformationJobObject = kernel32.func('SetInformationJobObject', 'bool', [
    'size_t',
    'int',
    'void *',
    'uint',
  ])

  _AssignProcessToJobObject = kernel32.func(
    'AssignProcessToJobObject',
    'bool',
    ['size_t', 'size_t']
  )

  _IsProcessInJob = kernel32.func('IsProcessInJob', 'bool', [
    'size_t',
    'size_t',
    'void *',
  ])

  _TerminateJobObject = kernel32.func('TerminateJobObject', 'bool', [
    'size_t',
    'uint',
  ])

  _QueryInformationJobObject = kernel32.func(
    'QueryInformationJobObject',
    'bool',
    ['size_t', 'int', 'void *', 'uint', 'void *']
  )

  _OpenProcess = kernel32.func('OpenProcess', 'size_t', [
    'uint',
    'bool',
    'uint',
  ])

  _CloseHandle = kernel32.func('CloseHandle', 'bool', ['size_t'])
}

/** Create a Windows Job Object. Returns a handle (non-zero number) or null. */
export function createJob(): number | null {
  if (!isWin32) return null
  ensureLoaded()

  const hJob = _CreateJobObjectW!(null, null)
  if (!hJob) return null

  // Allocate JOBOBJECT_EXTENDED_LIMIT_INFORMATION and set KILL_ON_JOB_CLOSE
  const info = Buffer.alloc(JOB_EXTENDED_INFO_SIZE, 0)
  info.writeInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET)

  const ok = _SetInformationJobObject!(
    hJob,
    JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
    info,
    JOB_EXTENDED_INFO_SIZE
  )

  if (!ok) {
    _CloseHandle!(hJob)
    return null
  }

  return hJob
}

/**
 * Assign a process (by PID) to the Job Object.
 * Returns true on success.
 */
export function assignPidToJob(hJob: number, pid: number): boolean {
  if (!isWin32) return false
  ensureLoaded()

  // PROCESS_SET_QUOTA (0x0100) | PROCESS_TERMINATE (0x0001) | PROCESS_QUERY_LIMITED_INFORMATION (0x1000)
  const access = 0x1101
  const hProcess = _OpenProcess!(access, false, pid)
  if (!hProcess) return false

  const ok = _AssignProcessToJobObject!(hJob, hProcess)
  _CloseHandle!(hProcess)
  return ok
}

/**
 * Assign a process (by raw HANDLE) to the Job Object.
 * Use this when you already have a process handle (e.g. from CreateProcessW).
 */
export function assignHandleToJob(hJob: number, hProcess: number): boolean {
  if (!isWin32) return false
  ensureLoaded()
  return _AssignProcessToJobObject!(hJob, hProcess)
}

/** Verify that a process belongs to the expected Job Object. */
export function isPidInJob(hJob: number, pid: number): boolean {
  if (!isWin32) return false
  ensureLoaded()

  const hProcess = _OpenProcess!(0x1000, false, pid)
  if (!hProcess) return false
  const result = Buffer.alloc(4)
  const ok = _IsProcessInJob!(hProcess, hJob, result)
  _CloseHandle!(hProcess)
  return ok && result.readInt32LE(0) !== 0
}

/** Terminate every active process in the Job Object. */
export function terminateJob(hJob: number, exitCode = 1): boolean {
  if (!isWin32) return false
  ensureLoaded()
  return _TerminateJobObject!(hJob, exitCode)
}

/** Return the number of active processes, or null when the query fails. */
export function getJobActiveProcessCount(hJob: number): number | null {
  if (!isWin32) return null
  ensureLoaded()
  const info = Buffer.alloc(JOB_BASIC_ACCOUNTING_INFO_SIZE)
  const ok = _QueryInformationJobObject!(
    hJob,
    JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION,
    info,
    JOB_BASIC_ACCOUNTING_INFO_SIZE,
    null
  )
  return ok ? info.readUInt32LE(ACTIVE_PROCESSES_OFFSET) : null
}

/** Close the Job Object handle. */
export function closeJob(hJob: number): void {
  if (!isWin32) return
  ensureLoaded()
  _CloseHandle!(hJob)
}
