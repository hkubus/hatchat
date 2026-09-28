import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Last line of defence for render errors. Without it a throw anywhere in the
 * tree — a bad message part, a failed lazy chunk — leaves a blank page and no
 * way back except a reload.
 */
export default class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("hat: render failed", error, info.componentStack);
  }

  private reload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="fatal">
        <div className="fatal-card">
          <h1>Something broke</h1>
          <p className="settings-hint">
            The interface hit an error it could not recover from. Your conversations are safe on
            the server.
          </p>
          <pre className="fatal-detail">{error.message}</pre>
          <div className="fatal-actions">
            <button onClick={this.reload}>Reload</button>
          </div>
        </div>
      </div>
    );
  }
}
