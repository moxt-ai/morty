import { createRootRoute, createRoute, createRouter, Link, Outlet, useParams } from "@tanstack/react-router";
import { reportApplicationError } from "../../index.ts";
import { setupPageClassName, setupSectionClassName } from "../setup/setup-card-shell.tsx";
import { CHAT_PREVIEW_STATE_LABELS, CHAT_PREVIEW_STATES, isChatPreviewStateId } from "./chat-preview.ts";
import { ChatPreviewPageContent } from "./chat-preview-page.tsx";

function ChatPreviewIndexPage() {
    return (
        <main className={setupPageClassName}>
            <section aria-labelledby="chat-preview-index-title" className={`${setupSectionClassName} md:max-w-[640px]`}>
                <h1 id="chat-preview-index-title" className="text-24 font-semibold tracking-[-0.03em]">
                    Chat 界面预览
                </h1>
                <p className="mt-2 text-14 leading-[22px] text-muted-foreground">
                    临时路由：无需连接本地 Agent 即可调整 Chat 布局与样式。上线前会移除。
                </p>
                <Link
                    className="mt-5 block rounded-xl border border-primary/25 bg-primary/5 px-4 py-4 text-14 transition-colors hover:bg-primary/10"
                    to="/chat/preview/$stateId"
                    params={{ stateId: "interactive" }}
                >
                    <span className="font-semibold text-primary">打开交互 playground</span>
                    <span className="mt-1 block text-muted-foreground">
                        连接、切换会话、发消息、弹窗等操作均使用本地模拟数据。
                    </span>
                </Link>
                <ul className="mt-6 grid gap-2">
                    {CHAT_PREVIEW_STATES.map((id) => (
                        <li key={id}>
                            <Link
                                className="block rounded-lg border border-border/60 bg-card px-4 py-3 text-14 transition-colors hover:bg-muted/40"
                                to="/chat/preview/$stateId"
                                params={{ stateId: id }}
                            >
                                <span className="font-medium">{CHAT_PREVIEW_STATE_LABELS[id]}</span>
                                <span className="mt-0.5 block font-mono text-xs text-muted-foreground">
                                    /chat/preview/{id}
                                </span>
                            </Link>
                        </li>
                    ))}
                </ul>
            </section>
        </main>
    );
}

function ChatPreviewStatePage() {
    const { stateId } = useParams({ from: "/chat/preview/$stateId" });
    if (!isChatPreviewStateId(stateId)) {
        return (
            <main className={setupPageClassName}>
                <section className={setupSectionClassName}>
                    <p role="alert" className="text-destructive">
                        未知的预览状态：{stateId}
                    </p>
                    <Link className="mt-4 inline-block text-primary underline underline-offset-4" to="/chat/preview">
                        返回预览列表
                    </Link>
                </section>
            </main>
        );
    }
    return <ChatPreviewPageContent previewId={stateId} />;
}

const rootRoute = createRootRoute({ component: Outlet });
const chatPreviewIndexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/chat/preview",
    component: ChatPreviewIndexPage,
});
const chatPreviewStateRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/chat/preview/$stateId",
    component: ChatPreviewStatePage,
});

export const chatPreviewRouter = createRouter({
    routeTree: rootRoute.addChildren([chatPreviewIndexRoute, chatPreviewStateRoute]),
    defaultOnCatch: (error) => reportApplicationError(error, "chat-preview-route"),
    scrollRestoration: true,
});
