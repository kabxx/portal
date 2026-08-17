# Skills

[Back to README](../../README.md)

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

Download, extraction, manifest, and resource limits are fixed product safety
boundaries rather than user configuration.

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

Local Skill directories are validated and registered in place; Portal does not
copy them. For a local collection, each discovered Skill keeps its original
absolute directory. HTTP(S) sources are downloaded and validated in a unique
directory under `<data-dir>/temp/skill-install/`. After validation, Portal
acquires the Skill state lock, rechecks registry and destination names, renames
prepared directories into `<data-dir>/skills/<name>`, and commits registry
state.

A source root containing `SKILL.md` is one Skill, even if its resource tree contains another file with that name. If the source root has no `SKILL.md`, portal recursively discovers Skill directories and stops descending whenever it finds one. Discovery order is deterministic. The complete source tree and every discovered Skill are validated before any registration or managed directory is committed. An invalid manifest, duplicate name, existing registry entry, or managed-directory conflict rejects the entire collection.

Removing an external absolute directory only removes its registry entry.
Removing a Portal-managed relative `skills/<name>` entry first renames that
directory into `<data-dir>/temp/skill-remove/`, commits registry removal, and
then deletes the temporary directory. A state write failure restores a
directory moved by the current operation.

If registry removal commits but the state lock or temporary directory
cleanup reports an error afterward, the removal remains successful and portal
returns a warning with the residual path instead of asking the user to retry.

Directory renames and Skill state replacement are separate filesystem
operations, not one cross-resource atomic transaction. portal serializes
cooperating writers and rolls back ordinary failures while it is running. If
the process is forcibly terminated between a directory rename and the state
commit, an unregistered managed directory or a temporary removal directory may
remain under `<data-dir>/`; portal does not automatically recover those crash
orphans.

## Registry

`<data-dir>/state/skills.json` is Portal-owned, versioned state. It records each
registered Skill's directory and enabled status and is managed only through
`/skill`. It is intentionally separate from user-authored `config.yaml`.

Relative directories resolve from `<data-dir>/`; absolute directories can point
anywhere on the local machine. Directories under `<data-dir>/skills/` that are
not registered are ignored. Portal rereads state for each Skill command and new
runtime. Invalid state blocks registry writes rather than discarding valid
entries. Writes use a temporary file followed by atomic replacement.

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

When a new agent thread or spawned runtime is created:

1. Portal reads registered Skills and enabled state from
   `state/skills.json`.
2. It creates an immutable catalog snapshot containing each enabled Skill's
   name, sanitized description, and absolute `SKILL.md` path.
3. Agent threads and spawned runtimes include that metadata under `## Skills`
   in the full setup prompt. The manifest body and resources are not injected.
4. Chat threads do not request the Skill snapshot because their Prompt plugin
   sends only the minimal handshake.

An active Prompt session keeps its catalog membership and metadata. Adding,
enabling, disabling, removing, or editing a Skill requires a new Agent thread
before the setup catalog changes. A resumed conversation opens no Prompt
session and sends no new setup turn to the existing provider conversation.
Newly enabled names are therefore advertised only by creating a new agent
thread or spawned runtime.

## Resources

Any regular file recursively contained in the Skill directory, other than
`SKILL.md`, is treated as a Skill resource during installation validation.
Resources are not listed or injected into the conversation. The setup catalog's
absolute manifest path allows a model with local command access to inspect the
Skill directory when needed.

## Storage

```text
<data-dir>/
├── config.yaml                # optional sparse user configuration
├── state/skills.json          # Portal-managed Skill registry
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

See [Security](../../SECURITY.md) for the full tool trust model.
