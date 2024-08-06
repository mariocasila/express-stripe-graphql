module.exports = {
  env: {
    node: true,
    commonjs: true,
    es2020: true,
  },
  extends: 'eslint:recommended',
  parserOptions: {
    ecmaVersion: 2020,
  },
  rules: {
    indent: ['error', 2],
    'linebreak-style': ['error', 'unix'],
    quotes: ['error', 'single', { avoidEscape: true }],
    semi: ['error', 'always'],
  },
  overrides: [
    {
      files: ['test/**'],
      plugins: ['jest'],
      extends: ['plugin:jest/recommended'],
      rules: { 'jest/prefer-expect-assertions': 'off' },
    },
  ],
};
