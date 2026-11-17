import next from "eslint-config-next";
import prettier from "eslint-config-prettier";

export default [
  ...next,
  {
    rules: {
      quotes: ["warn", "double", { allowTemplateLiterals: true }],
      "react-hooks/exhaustive-deps": ["off"],
      "react-hooks/set-state-in-effect": ["off"],
      "react-hooks/immutability": ["off"],
      "react-hooks/refs": ["off"],
      "import/no-anonymous-default-export": ["off"],
      "no-unused-vars": ["off"],
      "react/no-unescaped-entities": ["off"],
      "@next/next/no-img-element": ["off"],
    },
  },
  prettier,
];
