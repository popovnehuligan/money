// wrangler.toml bundles .html files as plain strings.
declare module '*.html' {
  const content: string;
  export default content;
}
