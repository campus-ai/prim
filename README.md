# @primitive/cli

CLI for managing Primitive tasks, specs, contexts, and git hooks.

## Installation

Requires Node.js 20+.

```bash
npm install -g @primitive/cli
```

Or use directly without installing:

```bash
npx @primitive/cli spec list
```

## Configuration

### 1. Set your Convex deployment URL

Create a `.env.local` file in your project directory:

```
VITE_CONVEX_URL=https://<your-deployment>.convex.cloud
```

Or set it as an environment variable:

```bash
export VITE_CONVEX_URL=https://<your-deployment>.convex.cloud
```

### 2. Authenticate

```bash
prim auth login
```

This opens your browser to complete the WorkOS OAuth flow. Once authenticated, your token is saved to `~/.config/prim/token`.

To use a token directly (e.g. in CI):

```bash
prim auth set-token <token>
```

## Commands

### Auth

```bash
prim auth login              # Authenticate via browser (WorkOS OAuth)
prim auth set-token <token>  # Save a bearer token manually
prim auth clear              # Remove saved tokens and revoke refresh token
```

### Tasks

```bash
prim task create -n "Task name"                    # Create a task
prim task create -n "Task name" -d "Description"   # Create with description
prim task create -n "Task name" --spec <contextId> # Create and link a spec
```

### Specs

Specs are context documents used to drive implementation. They can be synced to a task DAG and have file patterns for automatic pre-commit hook integration.

```bash
prim spec list                        # List all spec documents
prim spec list --task-id <id>         # Find spec for a root task
prim spec get <id>                    # Show spec details and metadata
prim spec get <id> --text-only        # Print raw spec text
prim spec update <id> --file spec.md  # Update spec from file
prim spec update <id> --name "New"    # Update spec name
prim spec sync <id>                   # Trigger spec-to-task sync
prim spec map <id> -p "src/auth/**"   # Map file patterns to a spec
prim spec unmap <id>                  # Clear all file patterns
prim spec unmap <id> -p "src/auth/**" # Remove specific pattern
prim spec import-mappings             # Migrate .primrc.json mappings to server
```

### Contexts

```bash
prim context list                     # List all contexts
prim context list --scope task        # Filter by scope (task/global/external)
prim context list --task-id <id>      # List contexts for a task
prim context get <id>                 # Get context details (JSON)
prim context create -s task -n "Name" # Create a context
prim context create -s task -n "Name" --file path/to/file  # Create from file
prim context create -s task -n "Name" --spec               # Create as spec
prim context update <id> --name "New" # Update a context
prim context delete <id>              # Delete a context
prim context link <id> --task <tid>   # Link context to task
prim context unlink <id> --task <tid> # Unlink context from task
```

### Git Hooks

```bash
prim hooks install    # Install pre-commit hook
prim hooks uninstall  # Remove pre-commit hook
```

The pre-commit hook automatically syncs specs when you commit changes to files that match a spec's file patterns (set via `prim spec map`).

Local settings can be configured in `.primrc.json`:

```json
{
  "analyzeChanges": true,
  "sessionNotesFile": ".prim-session.md"
}
```

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

MIT
