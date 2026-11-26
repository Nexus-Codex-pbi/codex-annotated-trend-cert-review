import powerbiVisualsConfigs from "eslint-plugin-powerbi-visuals";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
    powerbiVisualsConfigs.configs.recommended,
    {
        // tests/ is the Node/Playwright harness: it never reaches the package (tests/package_check.sh).
        ignores: ["node_modules/**", "dist/**", ".vscode/**", ".tmp/**", ".claude/**", "tests/**"],
    },
    {
        files: ["src/**/*.ts"],
        plugins: { "@typescript-eslint": tsPlugin },
        rules: { "@typescript-eslint/no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^_" }] },
    },
];
