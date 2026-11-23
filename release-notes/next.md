# v2.4.2

- Refreshed the suggested models for every provider. New defaults: Claude Sonnet 5.5 (Anthropic), GPT-6.2 Sol (OpenAI), Grok 4.7 (xAI), Kimi K3.1 Pro (OpenRouter) and GLM-5.3 (Hugging Face). AI Studio and Vertex AI now also offer Gemini 4 Hydrogen, Argon, Neon and Carbon, and keep Gemini 3.8 Flash as the default. Discontinued models (gpt-5.6, deepseek-v4-flash) are gone, and Gemini 3.5 Flash Lite is no longer suggested.
- OpenAI's GPT-6 models now work with tools; they previously failed with a 400 error about function tools and reasoning effort.
- ACP clients on the v2 protocol built with a recent ACP SDK now see Gaunt Sloth's slash commands, such as /approvals; their command menu was previously empty.
- With `-g`, prompt files are now read from the global config's own directory first (for example `~/.gsloth/.gsloth-settings/<profile>/`), so a global profile can carry its own prompts; previously a relative prompt path in a global profile failed with "not found".
