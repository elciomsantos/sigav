const GlobalStyle = () => {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
          a { color: inherit; text-decoration: none; }
          /* A coluna de conteúdo do layout é flex (para a página preencher a
             altura). Numa coluna flex, um Container do Mantine filho direto
             encolheria para a largura do conteúdo por causa das margens
             automáticas — width: 100% devolve o comportamento de bloco,
             respeitando o max-width de cada tela. */
          .app-content > .mantine-Container-root { width: 100%; }
          /* Cabeçalho com tom levemente mais escuro que o corpo branco, para a
             tela não ficar inteiramente branca. */
          [data-mantine-color-scheme='light'] .app-header {
            background-color: #f1f3f5;
            border-bottom: 1px solid #dee2e6;
          }
          [data-mantine-color-scheme='dark'] .app-header {
            background-color: #1f2023;
            border-bottom: 1px solid #373a40;
          }
          [data-mantine-color-scheme='dark'] table.md, [data-mantine-color-scheme='dark'] table.md th:nth-of-type(odd), [data-mantine-color-scheme='dark'] table.md td:nth-of-type(odd) {
            background: rgba(50, 50, 50, 0.5);
          }
          [data-mantine-color-scheme='light'] table.md, [data-mantine-color-scheme='light'] table.md th:nth-of-type(odd), [data-mantine-color-scheme='light'] table.md td:nth-of-type(odd) {
            background: rgba(220, 220, 220, 0.5);
          }
          table.md td {
            padding-left: 0.5em;
            padding-right: 0.5em;
          }
          video::-webkit-media-controls-fullscreen-button {
            display: none !important;
          }
        `,
      }}
    />
  );
};
export default GlobalStyle;
