import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import starlightLinksValidator from "starlight-links-validator"

export default defineConfig({
  integrations: [
    starlight({
      title: "acc",
      description: "A small terminal coding agent that reads, edits, and runs code in the current directory.",
      social: [{ icon: "github", label: "GitHub", href: "https://github.com/Xuxyyy/coding-cli" }],
      plugins: [starlightLinksValidator()],
      sidebar: [
        { label: "Start", autogenerate: { directory: "start" } },
        { label: "Guide", autogenerate: { directory: "guide" } },
        { label: "Reference", autogenerate: { directory: "reference" } },
      ],
    }),
  ],
})
