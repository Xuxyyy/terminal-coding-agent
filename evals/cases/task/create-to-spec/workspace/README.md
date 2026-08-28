# slugify

This project ships exactly one module, `src/slugify.js`.

It exports one named function, `slugify(text)`, which returns a URL slug:

- the text is lowercased;
- every run of characters that are not ASCII letters or digits becomes a
  single `-`;
- a leading or trailing `-` is removed.

For example, `slugify('Hello, World!')` returns `'hello-world'`, and
`slugify('  Trim  Me  ')` returns `'trim-me'`.
