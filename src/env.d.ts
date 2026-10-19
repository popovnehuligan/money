// wrangler.toml bundles these files as plain strings.
declare module '*.html' {
  const content: string;
  export default content;
}
declare module '*.gs' {
  const content: string;
  export default content;
}
