module.exports = {
    forbidden: [
        {
            name: "storage-does-not-depend-on-upper-layers",
            severity: "error",
            from: {
                path: [
                    "^packages/worker/src/(schema|storage|entity|infra)/",
                    "^packages/worker/src/components/[^/]+/(schema|storage|entity|infra)/",
                ],
            },
            to: {
                reachable: true,
                path: [
                    "^packages/worker/src/(service|http|composition|gateway|do)/",
                    "^packages/worker/src/components/[^/]+/(service|http|composition|gateway|do)/",
                ],
            },
        },
        {
            name: "browser-does-not-import-worker-implementation",
            severity: "error",
            from: { path: "^packages/web/src/" },
            to: { path: "^packages/worker/" },
        },
        {
            name: "worker-does-not-import-browser-implementation",
            severity: "error",
            from: { path: "^packages/worker/src/" },
            to: {
                path: "^packages/web/",
                // Public instruction text is served by the Worker, without browser code.
                pathNot: "^packages/web/content/instructions/[^/]+\\.txt$",
            },
        },
        {
            name: "session-pane-contracts-do-not-import-the-pane",
            severity: "error",
            comment:
                "The Session pane composes its contracts; a contract importing the pane would make the pane a dependency of its own parts.",
            from: {
                path: "^packages/web/src/view-models/chat/session-(connection|interaction-store|lifecycle|settings-store|turn-ledger)\\.ts$",
            },
            to: { path: "^packages/web/src/view-models/chat/session-pane-store\\.ts$" },
        },
        {
            name: "session-pane-contracts-are-independent",
            severity: "error",
            comment:
                "Connection, interactions, settings and the turn ledger each own one part of the Session's state; the pane coordinates them.",
            from: {
                path: "^packages/web/src/view-models/chat/session-(connection|interaction-store|settings-store|turn-ledger)\\.ts$",
            },
            to: {
                path: "^packages/web/src/view-models/chat/session-(connection|interaction-store|settings-store|turn-ledger)\\.ts$",
            },
        },
        {
            name: "web-utils-do-not-import-business-layers",
            severity: "error",
            comment: "DOM utilities stay business-agnostic: they may not import views, view-models, or services.",
            from: { path: "^packages/web/src/components/utils/" },
            to: {
                path: ["^packages/web/src/views/", "^packages/web/src/view-models/", "^packages/web/src/services/"],
            },
        },
        {
            name: "web-components-do-not-import-business-layers",
            severity: "error",
            comment:
                "Components may use React hooks but stay business-decoupled: they may not import views, view-models, or services. Business-coupled UI belongs in views.",
            from: { path: "^packages/web/src/components/" },
            to: {
                path: ["^packages/web/src/views/", "^packages/web/src/view-models/", "^packages/web/src/services/"],
                // Type-only imports carry no runtime coupling; components may
                // render against view-model contracts passed in as props.
                dependencyTypesNot: ["type-only"],
            },
        },
    ],
    options: {
        doNotFollow: { path: "node_modules|third-party" },
        tsPreCompilationDeps: true,
        enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "types", "default"] },
    },
};
