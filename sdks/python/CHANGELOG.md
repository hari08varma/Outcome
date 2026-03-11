# Changelog

## 0.1.0 (2026-03-09)

### Added
- Synchronous client (`Layer5`)
- Async client (`AsyncLayer5`)
- Full error hierarchy with actionable messages
- Retry logic with exponential backoff + jitter
- Pydantic models for all request/response payloads
- LangChain callback integration (`Layer5Callback`)
- CrewAI tool wrapper integration (`layer5_tool`, `layer5_crew`)
- AutoGen hook integration (`Layer5AutoGenHook`)
- Decorator integration (`@track`)
- Environment variable support (`LAYER5_API_KEY`, `LAYER5_BASE_URL`)
