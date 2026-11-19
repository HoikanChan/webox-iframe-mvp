export type SandboxMode = 'strict' | 'iframe';

export interface AddAppOptions {
  id?: string;
  url: string;
  target: HTMLElement;
  contextRoot?: string;
  externalRoot?: string;
  roarand?: string;
  sandboxMode?: SandboxMode;
  syncRoute?: boolean;
  onRouteChange?: (href: string, type: 'pushState' | 'replaceState' | 'popstate' | 'hashchange') => void;
}

export interface WeboxApp {
  id: string;
  url: string;
  currentUrl?: string;
  target: HTMLElement;
  container?: HTMLElement;
  contextRoot: string;
  externalRoot: string;
  roarand?: string;
  sandboxMode: SandboxMode;
  syncRoute: boolean;
  shadowRoot?: ShadowRoot;
  shadowHead?: HTMLElement;
  renderRoot?: HTMLElement;
  iframe?: HTMLIFrameElement;
  iframeWindow?: Window;
  iframeDocument?: Document;
  windowProxy?: Window;
  broadcast: (topic: string, message: any) => void;
}
