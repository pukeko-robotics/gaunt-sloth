# JavaScript Config Example

This example demonstrates how to use JavaScript configuration files (`.gsloth.config.js`) to extend Gaunt Sloth with custom middleware and tools that aren't available in JSON configs.

## Features Demonstrated

### 1. Custom Middleware
The example includes a `loggingMiddleware` built with LangChain's `createMiddleware` helper (required to brand middleware instances) that logs at all lifecycle points:
- `beforeAgent` - Called before agent initialization
- `beforeModel` - Called before each LLM invocation
- `afterModel` - Called after each LLM response
- `afterAgent` - Called after agent completion

### 2. Custom Tool
The example includes a `custom_logger` tool similar to the built-in `gth_status_update` tool:
- Accepts a message and optional log level
- Uses emojis to indicate log level (ℹ️ info, ⚠️ warning, ✅ success)
- Can be called by the agent during execution

## Usage

1. **Copy this directory** to your project root or use it as reference
2. **Install dependencies** (if not already installed):
   ```bash
   pnpm install
   ```
3. **Run Gaunt Sloth** from this directory:
   ```bash
   gth chat "Tell me about custom middleware"
   ```

## How It Works

### JavaScript vs JSON Configs

**JSON Config** (`.gsloth.config.json`):
- Can only use predefined middleware (strings or config objects)
- Cannot define custom tools
- Simpler but less flexible

**JavaScript Config** (`.gsloth.config.js`):
- Can define custom middleware (use `createMiddleware` to brand them)
- Can create custom tools using LangChain's `tool()` function
- Full programmatic control over configuration
- Requires Node.js/ES modules knowledge

### Custom Middleware Structure

```javascript
import { createMiddleware } from 'langchain';

const customMiddleware = createMiddleware({
  name: 'my-middleware',

  beforeAgent(state) {
    // Called once before agent starts
    // Modify state if needed
    return state;
  },

  beforeModel(state) {
    // Called before each LLM call
    return state;
  },

  afterModel(state) {
    // Called after each LLM response
    return state;
  },

  afterAgent(state) {
    // Called once after agent completes
    return state;
  },
});
```

Always wrap custom middleware with `createMiddleware` so it includes the `MIDDLEWARE_BRAND` marker expected by LangChain/Gaunt Sloth.

### Custom Tool Structure

```javascript
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const myTool = tool(
  (input) => {
    // Tool implementation
    return `Result: ${input.param}`;
  },
  {
    name: 'my_tool',
    description: 'What the tool does',
    schema: z.object({
      param: z.string().describe('Parameter description'),
    }),
  }
);
```

## Expected Output

When you run this example, you'll see logging output like:

```
🚀 [Middleware] beforeAgent - Agent execution starting
   Input: "Tell me about custom middleware"...
🤖 [Middleware] beforeModel - About to call LLM
   Messages count: 2
✅ [Middleware] afterModel - LLM responded
   Response preview: Custom middleware allows you to...
🏁 [Middleware] afterAgent - Agent execution complete
   Final message count: 4
```

And if the agent uses the custom tool:

```
ℹ️ [Custom Tool] Processing data...
```

## Next Steps

- Modify the middleware to add your own logic (e.g., rate limiting, caching, metrics)
- Create custom tools that integrate with your systems (e.g., database queries, API calls)
- Combine multiple middleware and tools for complex workflows
- See `src/middleware/types.ts` for full middleware API documentation
