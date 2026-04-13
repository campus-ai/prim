# @primitive.ai/prim

The official CLI for [Primitive](https://getprimitive.ai). Manage specs, contexts, projects, and git hooks from the command line.

> [!WARNING]
> This project is in **alpha**. Commands and APIs may change between releases.

## Installation

Requires Node.js 20+.

```bash
npm install -g @primitive.ai/prim
```

Or run directly without installing:

```bash
npx @primitive.ai/prim
```

## Quick Start

```bash
# Authenticate via browser (WorkOS OAuth)
prim auth login

# List your specs
prim spec list

# Install the pre-commit hook
prim hooks install
```

## Commands

### Auth

```bash
prim auth login              # Authenticate via browser
prim auth set-token <token>  # Save a bearer token (e.g. for CI)
prim auth clear              # Remove saved tokens
prim auth status             # Check authentication status
```

### Specs

Specs are documents that drive implementation. They can be synced to a project DAG and mapped to file patterns for automatic pre-commit hook integration.

```bash
prim spec list                        # List all specs
prim spec list --project-id <id>      # Find spec for a root project
prim spec get <id>                    # Show spec details
prim spec get <id> --text-only        # Print raw spec text
prim spec update <id> --file spec.md  # Update spec from file
prim spec update <id> --name "New"    # Rename a spec
prim spec sync <id>                   # Trigger spec-to-project sync
prim spec map <id> -p "src/auth/**"   # Map file patterns to a spec
prim spec unmap <id>                  # Clear all file patterns
prim spec unmap <id> -p "src/auth/**" # Remove specific pattern
prim spec auto-map <id>              # Auto-detect file patterns
```

### Contexts

```bash
prim context list                        # List all contexts
prim context list --scope project        # Filter by scope
prim context list --project-id <id>      # List contexts for a project
prim context get <id>                    # Get context details
prim context create -s project -n "Name" # Create a context
prim context create -s project -n "Name" --file path/to/file
prim context update <id> --name "New"    # Update a context
prim context delete <id>                 # Delete a context
prim context link <id> --project <pid>   # Link context to project
prim context unlink <id> --project <pid> # Unlink context from project
```

### Projects

```bash
prim project create -n "Project name"                    # Create a project
prim project create -n "Project name" -d "Description"   # Create with description
prim project create -n "Project name" --spec <contextId> # Create and link a spec
```

### Hooks

```bash
prim hooks install    # Install pre-commit hook
prim hooks uninstall  # Remove pre-commit hook
```

The pre-commit hook automatically syncs specs when you commit changes to files matching a spec's file patterns (configured via `prim spec map`).

Supports [Husky](https://typicode.github.io/husky/) — `prim hooks install` detects Husky and offers to install into `.husky/pre-commit`.

## Development

```bash
pnpm install
pnpm dev          # Build in watch mode
pnpm build        # Production build
pnpm test         # Run tests
pnpm typecheck    # Type-check
pnpm lint         # Lint
```

## License

[MIT](LICENSE)
