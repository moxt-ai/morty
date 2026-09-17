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
