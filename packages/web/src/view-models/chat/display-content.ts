/**
 * In-memory display model for tool call content rendering. Derived from raw
 * session event content in the view-model layer; it never crosses a transport.
 */
export type AgentDisplayContent =
    | { readonly text: string; readonly type: "text" }
    | {
          readonly data: string;
          readonly mimeType: string;
          readonly name: string;
          readonly type: "image";
          readonly uri: string;
      }
    | {
          readonly data: string;
          readonly mimeType: string;
          readonly name: string;
          readonly text: string;
          readonly type: "resource";
          readonly uri: string;
      }
    | {
          readonly mimeType: string;
          readonly name: string;
          readonly text: string;
          readonly type: "resource_link";
          readonly uri: string;
      }
    | { readonly newText: string; readonly oldText: string; readonly path: string; readonly type: "diff" }
    | { readonly terminalId: string; readonly type: "terminal" };
