---
metadata:
  change-policy: >-
    Do not modify this Markdown file together with source code or other non-Markdown
    files. Submit changes in a separate documentation-only pull request for review
    and approval. The recommended reviewer is taowen-paraflow.
---

# Web Architecture Rules

These rules apply to `packages/web`. Repository-wide rules in the root `AGENTS.md` also apply.

## View-model-driven UI

- Put business workflows, asynchronous operations, validation, state transitions, derived business data, and user-facing failure mapping in `src/view-models`.
- Model workflow state as readonly discriminated unions. Keep invalid combinations unrepresentable and handle variants exhaustively.
- Use Zustand stores in the view-model layer. Prefer vanilla `createStore` factories for screen- or resource-scoped state and the existing Zustand `create` API for intentionally shared application state.
- Keep each store scoped to one cohesive workflow. Split screens with independent loading, editing, submission, or lifecycle concerns into collaborating stores instead of building a page-sized store.
- Do not implement view-models as custom React hooks. Components create or receive a store and subscribe with Zustand's `useStore`.
- Store actions that perform external work must accept an `AbortSignal`, propagate cancellation, and avoid publishing state after cancellation.
- Inject external ports or construct production clients inside store factories. Components must not coordinate multi-step service workflows.

## Components and views

### Components

- `src/components` holds files that are pure UI or render read-only data. Components render what they receive and stay focused on rendering and interaction wiring.
- React hooks are allowed in components so developers can implement complex animation, visual effects, and better UI/UX.
- Components must not import `src/views`, and must not reference business lifecycle or resource management. Keep API calls, domain validation, retries, polling, error translation, and business-state transitions out of components.
- Components may own ephemeral DOM-only state such as focus targets, element measurements, disclosure/popover visibility, uncontrolled input refs, and effects that bind and release browser or DOM resources such as listeners, timers, observers, and object URLs.

### Views

- `src/views` holds heavy business components and business logic. Views consume readonly view-model state and invoke store actions.
- React hooks such as `useRef`, `useMemo`, `useState`, `useEffect`, and the rest are forbidden in views.
- View state is managed by the view-model layer (Zustand stores) and must have an explicit business lifecycle.
- Data flows into views from route loaders, DOM callbacks such as user interactions and network requests, and DOM attach/detach through the `onAttach(element)` pattern.
- DOM attach/detach is a workaround to reconsider later; prefer explicit state and callback flow when a view can be expressed without it.
- Routing remains in views, but route loading and route-level business state belong in view-model stores. Pass navigation as a callback when a completed workflow needs it.

## Testing

- For routine local work, run `pnpm lint`, `pnpm typecheck`, and only related test
  cases. Use `pnpm ci:check` locally only to diagnose the combined CI validation.
- Integration tests enter through navigation or exercise user behavior through mouse and keyboard operations. Direct access to stores in tests is forbidden.
- Integration tests must bootstrap and render the entire application. Rendering individual React components or views in an integration test is forbidden.
- Tests prefer accessible roles, names, labels, and visible text. Use constants from `data-testid.ts` when an element has no stable semantic selector or the ID represents a supported product state. Ad hoc test IDs and selectors coupled to styling or DOM structure are forbidden.
- Use the complete real application, router, Zustand stores, SDK/API clients, Chat Worker, Platform, Runtime relay, production daemon, transports, and storage. Inject a stateful controlled ACP harness only through the daemon's Agent dependency argument. Do not fake the API transport, replace modules, inject stores, or define request mocks inside scenarios.
- Cover real daemon and Agent adapter behavior separately in Mobius agent-daemon integration tests with real Agent executables. See the repository `TESTING.md` for external identity/model-provider exceptions.
