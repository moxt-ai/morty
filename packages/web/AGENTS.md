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

- Components and views consume readonly view-model state and invoke store actions. Keep them focused on rendering and interaction wiring.
- Components may own ephemeral DOM-only state such as focus targets, element measurements, disclosure/popover visibility, and uncontrolled input refs.
- Keep API calls, domain validation, retries, polling, error translation, and business-state transitions out of `.tsx` files.
- Routing remains in views, but route loading and route-level business state belong in view-model stores. Pass navigation as a callback when a completed workflow needs it.

## Testing

- For routine local work, run `pnpm lint`, `pnpm typecheck`, and only related test
  cases. Use `pnpm ci:check` locally only to diagnose the combined CI validation.
- Integration tests enter through navigation or exercise user behavior through mouse and keyboard operations. Direct access to stores in tests is forbidden.
- Integration tests must bootstrap and render the entire application. Rendering individual React components or views in an integration test is forbidden.
- Tests prefer accessible roles, names, labels, and visible text. Use constants from `data-testid.ts` when an element has no stable semantic selector or the ID represents a supported product state. Ad hoc test IDs and selectors coupled to styling or DOM structure are forbidden.
- Use the complete real application, router, Zustand stores, SDK/API clients, Chat Worker, Platform, Runtime relay, transports, and storage. Replace the local daemon with a stateful fake connected through the public daemon protocol. Do not import or start controlled ACP Agents or the production daemon, fake the API transport, replace modules, inject stores, or define request mocks inside scenarios.
- Cover real daemon and Agent adapter behavior separately in Mobius agent-daemon integration tests with real Agent executables. See the repository `TESTING.md` for external identity/model-provider exceptions.
