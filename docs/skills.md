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

Current validation rules include:

- `name` uses 1–64 lowercase letters, numbers, and single hyphens;
- the registry name matches the manifest name;
- `description` is a non-empty string of at most 1,024 characters;
- the instruction body is not empty;
- `SKILL.md` is at most 512 KiB;
- symbolic links are rejected;
- a skill may list at most 2,000 resource files at runtime.

## Commands

| Command                 | Behavior                                                     |
| ----------------------- | ------------------------------------------------------------ |
| `/skill add <source>`   | Register a local directory or download a remote skill        |
| `/skill list`           | List registered skills, enabled state, and validation issues |
| `/skill enable <name>`  | Enable a registered skill for new runtimes                   |
| `/skill disable <name>` | Disable a registered skill for new runtimes                  |
| `/skill remove <name>`  | Unregister a skill and delete its portal-managed download    |

Examples:

```text
/skill add C:\path\to\release-notes
/skill add https://example.com/SKILL.md
/skill add https://github.com/owner/repository/tree/main/skills/release-notes
/skill add https://example.com/release-notes.zip
/skill list
```

Local directories are validated and registered in place; portal does not copy them. HTTP(S) sources are downloaded into `data/skills/<name>` and then registered.

Removing an external absolute directory only removes its registry entry. Removing a portal-managed relative `skills/<name>` entry also deletes that directory.

## Registry

The `skills` section of `data/config.yaml` is the sole source of truth for which skills exist:

```yaml
skills:
  - name: release-notes
    directory: D:/shared-skills/release-notes
    enabled: true
  - name: pdf-processing
    directory: skills/pdf-processing
    enabled: false
```

The `skills` section is an array. Each item contains only `name`, `directory`, and `enabled`; `name` must match the corresponding manifest name. Relative directories resolve from `data/`; absolute directories can point anywhere on the local machine. Directories under `data/skills/` that are not registered are ignored.

During startup, when `config.yaml` does not exist, portal creates it once and imports valid directories already present under `data/skills/`; every imported entry is enabled. Existing configuration, including malformed registries, is never overwritten during startup initialization.

portal rereads the registry for every skill command and new runtime. Invalid YAML or a non-array `skills` section prevents registry writes and new runtime creation without overwriting the file. A malformed entry is reported separately while other valid entries remain available. Duplicate names are reported as entry errors and every entry with that name is excluded from the catalog. Write commands are blocked until all entry errors are fixed so user data cannot be dropped accidentally. A structurally valid entry with missing or invalid skill files remains removable.

Registry writes use a temporary file followed by an atomic replacement.

## Supported sources

`/skill add` accepts:

- a local skill directory;
- a direct `SKILL.md` URL;
- a GitHub repository URL;
- a GitHub `tree` URL pointing to a skill subdirectory;
- a GitHub `blob` URL pointing to `SKILL.md`;
- ZIP, 7z, RAR, TAR, TGZ, and TAR.GZ archives.

Downloads and extracted trees are bounded by file-count and byte limits. Archive entries are checked for absolute paths and `..` traversal, and extracted trees are rejected when they contain symbolic links. An archive must resolve to exactly one skill candidate unless a GitHub subdirectory was explicitly selected.

These checks reduce accidental damage; they do not prove that a skill is safe.

## Runtime lifecycle

When a newly opened thread or spawned runtime is created:

1. portal reads registered skills and their enabled state from `config.yaml`.
2. It creates an immutable catalog snapshot containing enabled skill names, descriptions, and directories.
3. The setup prompt advertises each skill's name and description.
4. If the browser model decides that a skill matches the task, it invokes `load_skill`.
5. portal rereads and validates the current `SKILL.md`, rescans its resources, and returns name, directory, resources, and instructions in the standard JSON Tool Result envelope.
6. The model continues using only the tools already available to the runtime.

An open runtime keeps its catalog membership: newly added or enabled skills require a new runtime, and disabling a skill does not remove it from an existing catalog. Skill files are loaded from disk on demand, so modifying them changes later `load_skill` results, while deleting or corrupting them returns an error even in an existing runtime.

A resumed conversation also creates a fresh snapshot from the current registry and registers `load_skill` when that snapshot is non-empty. Resume uses `skipSetup: true`, however, so portal does not submit a new `# Skills` catalog or Tool definition turn. The provider conversation keeps the catalog it previously saw; newly enabled names are therefore reliably advertised only by opening a new thread or creating a spawned runtime.

## Resources

Any regular file recursively contained in the skill directory, other than `SKILL.md`, is treated as a skill resource and listed with a relative path. The loaded instructions tell the model to resolve those paths against the skill directory.

Resources are not automatically injected into the conversation. The model must use an available tool, such as `run_command`, when it needs to inspect a resource.

## Storage

```text
data/
├── config.yaml                # user-editable browser, MCP, and Skill configuration
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
