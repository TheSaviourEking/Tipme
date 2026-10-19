# Contracts agent rules
- Public cross-app DTOs/schemas and event names live here. Exports must not depend on NestJS, Next.js, ORM or browser-specific runtime.
- Version breaking changes deliberately. API validates inputs and converts to domain objects; web validates responses where needed.
- Never put money amounts in floating-point contract fields.
