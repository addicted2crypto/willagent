# Known Issues & Solutions

This document tracks solved issues that should NOT be reverted.

---

## TypeScript: baseUrl Deprecation Warning

**Issue**: IDE shows warning about `baseUrl` being deprecated in TypeScript 7.0

**Solution**: Add `"ignoreDeprecations": "5.0"` to tsconfig.json

```json
{
  "compilerOptions": {
    "ignoreDeprecations": "5.0",  // DO NOT REMOVE - silences baseUrl warning
    "baseUrl": "./",
    "paths": { ... }
  }
}
```

**Why**: We use `baseUrl` + `paths` for module aliases (`@agent/*`, `@models/*`, etc.). The warning is about a future TS 7.0 change but we're on TS 5.x.

**DO NOT**:
- Remove `ignoreDeprecations`
- Change value to `"6.0"` (not valid for TS 5.x)
- Remove `baseUrl` (breaks path aliases)

---

## Complexity Router: Tool Count Bug

**Issue**: All queries routed to GPT120B because complexity classifier counted available tools

**Solution**: Modified `classifyComplexity()` in `model-router.service.ts` to analyze input text, not count tools

**Key change**: Parameter renamed to `_toolsRequired` (prefixed with underscore, ignored)

**DO NOT**: Revert to counting `toolsRequired.length` for complexity

---

## Static File Serving: 404 on Root

**Issue**: Terminal UI showed "Cannot GET /"

**Solution**: Use `process.cwd()` instead of `__dirname` for path resolution in `app.module.ts`

```typescript
ServeStaticModule.forRoot({
  rootPath: join(process.cwd(), 'public'),  // NOT __dirname
  exclude: ['/api*', '/docs*'],
}),
```

**Why**: `__dirname` resolves differently in compiled vs source code. `process.cwd()` always gives project root.

---

## OpenWebUI Connection

**Config in `.env`**:
```env
OPENWEBUI_BASE_URL=https://robai.net/api/v1
OPENWEBUI_API_KEY=sk-xxx
LOCAL_MODEL_NAME=VL 30B
TURBO_MODEL_NAME=GPT120B
```

**DO NOT**:
- Use `localhost:3000` (that's not where OpenWebUI is)
- Use placeholder names like `robai-micro` (actual names are `VL 30B`, `GPT120B`)

---

## GitHub CLI Path

**Issue**: `gh` command not found after install via winget

**Solution**: Add to PATH: `C:\Program Files\GitHub CLI`

Or use full path: `& "C:\Program Files\GitHub CLI\gh.exe" <command>`
