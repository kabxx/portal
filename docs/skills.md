# Skills

[Back to README](../README.md)

A skill is a local directory containing a `SKILL.md` manifest and optional resource files. Skills provide task-specific instructions; they do not add or expand the tools available to the model.

## Manifest format

Every skill directory must contain a UTF-8 `SKILL.md` with YAML frontmatter followed by a non-empty Markdown instruction body:

```markdown
---
name: release-notes
description: Prepare concise release notes from a Git diff and commit history.
---

# Instructions

Inspect the requested changes, group them by user impact, and write a short release summary.
```

Default validation rules include:

- `name` uses 1–64 lowercase letters, numbers, and single hyphens;
- the registry name matches the manifest name;
- `description` is a non-empty string of at most 1,024 characters;
- the instruction body is not empty;
- `SKILL.md` is at most 512 KiB;
- symbolic links are rejected;
- a skill may list at most 2,000 resource files at runtime.

Download, extraction, manifest, and resource limits can be changed under
`advanced.skillInstall`; see [Configuration](configuration.md).

## Commands

| Command                              | Behavior                                                       |
| ------------------------------------ | -------------------------------------------------------------- |
| `/skill add <source>`                | Register or download one Skill or a Skill collection           |
| `/skill add <name> --registry <url>` | Download the latest named Skill from a Hub-compatible registry |
| `/skill list`                        | List registered Skills, enabled state, and validation issues   |
| `/skill enable <name>`               | Enable a registered Skill for new runtimes                     |
| `/skill disable <name>`              | Disable a registered Skill for new runtimes                    |
| `/skill remove <name>`               | Unregister a Skill and delete its portal-managed download      |

Examples:

```text
/skill add C:\path\to\release-notes
/skill add C:\path\to\skill-collection
/skill add https://example.com/SKILL.md
/skill add https://github.com/owner/repository/tree/main/skills/release-notes
/skill add https://example.com/release-notes.zip
/skill add release-notes --registry https://skills.example.com
/skill list
```

Local Skill directories are validated and registered in place; portal does not copy them. For a local collection, each discovered Skill keeps its original absolute directory. HTTP(S) sources are downloaded and validated in a unique directory under `data/temp/skill-install/`. After validation, portal acquires the configuration lock, rechecks the registry and destination names, renames the prepared directories into `data/skills/<name>`, and commits the registry update.

A source root containing `SKILL.md` is one Skill, even if its resource tree contains another file with that name. If the source root has no `SKILL.md`, portal recursively discovers Skill directories and stops descending whenever it finds one. Discovery order is deterministic. The complete source tree and every discovered Skill are validated before any registration or managed directory is committed. An invalid manifest, duplicate name, existing registry entry, or managed-directory conflict rejects the entire collection.

Removing an external absolute directory only removes its registry entry. Removing a portal-managed relative `skills/<name>` entry first renames that directory into `data/temp/skill-remove/`, commits the registry removal, and then deletes the temporary directory. A configuration write failure restores a directory moved by the current operation.

If registry removal commits but the configuration lock or temporary directory
cleanup reports an error afterward, the removal remains successful and portal
returns a warning with the residual path instead of asking the user to retry.

Directory renames and `config.yaml` replacement are separate filesystem
operations, not one cross-resource atomic transaction. portal serializes
cooperating writers and rolls back ordinary failures while it is running. If
the process is forcibly terminated between a directory rename and the config
commit, an unregistered managed directory or a temporary removal directory may
remain under `data/`; portal does not automatically recover those crash
orphans.

The HTTP API accepts the same install inputs through `POST /v1/skills` with
`{ "source": "...", "registryUrl": "..." }`. Omit `registryUrl` for a local
path or direct remote source. See [HTTP API](api.md).

## Manual selection

An enabled Skill can be selected explicitly for one turn by putting its name at
the start of the input:

```text
$release-notes Summarize the changes since the last tag.
$release-notes
```

The prefix must be `$` followed immediately by the exact registered name. The
Skill must be enabled in the current runtime snapshot. portal loads its current
manifest and resources, wraps the optional trailing text as the user task, and
applies the Skill only to that turn. With no trailing task, the model is told to
ask what to do. An unknown or unavailable `$name` prefix remains ordinary user
input.

`POST /v1/threads/:threadId/skill` provides the activation-only form by name;
it does not synthesize the combined `$name task` form.

## Registry

The `skills` section of `data/config.yaml` is the sole source of truth for which skills exist:

```yaml
skills:
  release-notes:
    directory: D:/shared-skills/release-notes
    enabled: true
  pdf-processing:
    directory: skills/pdf-processing
    enabled: false
```

The `skills` section is an object keyed by Skill name. Each value contains only
`directory` and `enabled`; the key must match the corresponding manifest name.
Relative directories resolve from `data/`; absolute directories can point
anywhere on the local machine. Directories under `data/skills/` that are not
registered are ignored.

During startup, when `config.yaml` does not exist, portal creates it once and imports valid directories already present under `data/skills/`; every imported entry is enabled. Existing configuration, including malformed registries, is never overwritten during startup initialization.

portal rereads the registry for every skill command and new runtime. Invalid
YAML or a non-object `skills` section prevents registry writes and new runtime
creation without overwriting the file. YAML duplicate keys are whole-file
errors. A malformed entry is reported separately while other valid entries
remain available. Write commands are blocked until all entry errors are fixed
so user data cannot be dropped accidentally. A structurally valid entry with
missing or invalid skill files remains removable.

Registry writes use a temporary file followed by an atomic replacement.

## Supported sources

`/skill add` accepts:

- a local Skill or collection directory;
- a direct `SKILL.md` URL;
- a GitHub repository URL;
- a GitHub `tree` URL pointing to a Skill or collection directory;
- a GitHub `blob` URL pointing to `SKILL.md`;
- ZIP, 7z, RAR, TAR, TGZ, and TAR.GZ archives.

The `--registry` form accepts one valid Skill name and an HTTP(S) registry URL.
portal requests `.well-known/clawhub.json` relative to that URL, resolves its `apiBase`, reads the
named Skill metadata and latest version, then downloads the corresponding
archive. Registry discovery, metadata, redirects, downloaded bytes, extracted
bytes, file count, and manifest validation use the same bounded installation
policy as other remote sources.

Downloads and extracted trees are bounded by file-count and byte limits. Archive entries are checked for absolute paths and `..` traversal, and extracted trees are rejected when they contain symbolic links. A local directory, GitHub location, or ordinary archive may resolve to one or more Skill directories. A direct `SKILL.md` URL and a named Hub registry package remain single-Skill sources; a Hub manifest name must match the requested slug.

These checks reduce accidental damage; they do not prove that a skill is safe.

## Runtime lifecycle

When a new agent thread, chat thread, or spawned runtime is created:

1. portal reads registered skills and their enabled state from `config.yaml`.
2. It creates an immutable catalog snapshot containing enabled skill names, descriptions, and directories.
3. Agent threads and spawned runtimes advertise each skill's name and description in the full setup prompt; chat threads retain the snapshot locally without advertising it.
4. If the browser model decides that a skill matches the task, it invokes `load_skill`.
5. portal rereads and validates the current `SKILL.md`, rescans its resources, and returns name, directory, resources, and instructions in the standard JSON Tool Result envelope.
6. The model continues using only the tools already available to the runtime.

An active runtime keeps its catalog membership: newly added or enabled skills require a new runtime, and disabling a skill does not remove it from an existing catalog. Skill files are loaded from disk on demand, so modifying them changes later `load_skill` results, while deleting or corrupting them returns an error even in an existing runtime.

A resumed conversation also creates a fresh snapshot from the current registry and registers `load_skill` when that snapshot is non-empty. Resume uses `setupMode: 'skip'`, however, so portal does not submit a new `# Skills` catalog or Tool definition turn. A chat thread likewise registers `load_skill` but sends only the minimal handshake. The provider conversation keeps whichever catalog it previously saw; newly enabled names are therefore reliably advertised only by creating a new agent thread or a spawned runtime.

## Resources

Any regular file recursively contained in the skill directory, other than `SKILL.md`, is treated as a skill resource and listed with a relative path. The loaded instructions tell the model to resolve those paths against the skill directory.

Resources are not automatically injected into the conversation. The model must use an available tool, such as `run_command`, when it needs to inspect a resource.

## Storage

```text
data/
├── config.yaml                # browser, instructions, API, MCP, Skills, Hooks, and limits
├── skills/<name>/             # remotely downloaded managed skills
└── temp/skill-install/        # temporary download workspace
```

Temporary download directories are removed after each remote add attempt. The managed data paths are ignored by Git; external local skill directories remain in their original locations.

## Trust and safety

Skill instructions can influence a model that has access to local commands and file modification. Before registration or installation:

- inspect `SKILL.md` and every included resource;
- prefer sources controlled by people you trust;
- prefer pinned Git references over moving branches when possible;
- avoid skills that ask for secrets or unrelated file access;
- test new skills in a disposable repository first.

See [Security](security.md) for the full tool trust model.
