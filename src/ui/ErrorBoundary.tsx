/** Filet de sécurité : une erreur d'affichage n'efface jamais l'écran (les données restent intactes). */
import React from 'react';

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.warn('Erreur d’affichage', error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crash">
        <h2>Oups, un écran n'a pas pu s'afficher</h2>
        <p>Vos données sont intactes, elles sont enregistrées sur ce téléphone.</p>
        <button className="btn btn-primary" onClick={() => this.setState({ error: null })}>
          Réessayer
        </button>
        <button className="btn btn-ghost" onClick={() => { location.hash = ''; location.reload(); }}>
          Revenir à l'accueil
        </button>
        <details>
          <summary>Détail technique</summary>
          <code>{String(this.state.error.message)}</code>
        </details>
      </div>
    );
  }
}
