import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import starlightLinksValidator from "starlight-links-validator"

export default defineConfig({
  site: "https://coding-cli-docs.vercel.app",
  devToolbar: { enabled: false },
  integrations: [
    starlight({
      title: "Coding CLI Docs",
      description: "A small terminal coding agent that reads, edits, and runs code in the current directory.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/Xuxyyy/coding-cli" }],
      plugins: [starlightLinksValidator()],
      sidebar: [
        { label: "Start", autogenerate: { directory: "start" } },
        { label: "Design", autogenerate: { directory: "design" } },
        { label: "Reference", autogenerate: { directory: "reference" } },
      ],
    }),
  ],
})
