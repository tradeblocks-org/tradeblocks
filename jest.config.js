/** @type {import('jest').Config} */
const config = {
  preset: "ts-jest",
  testEnvironment: "jsdom",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/__tests__/**/*.{js,jsx,ts,tsx}", "**/*.(test|spec).{js,jsx,ts,tsx}"],
  transform: {
    "^.+\\.(ts|tsx)$": ["ts-jest", { tsconfig: { jsx: "react-jsx" } }],
  },
  moduleNameMapper: {
    "^@tradeblocks/lib/stores$": "<rootDir>/packages/lib/stores/index.ts",
    "^@tradeblocks/lib$": "<rootDir>/packages/lib/index.ts",
    "^@/(.*)$": "<rootDir>/$1",
  },
  setupFilesAfterEnv: ["<rootDir>/tests/setup.ts"],
  collectCoverageFrom: ["lib/**/*.{ts,tsx}", "!lib/**/*.d.ts", "!lib/**/index.ts"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov", "html"],
  verbose: true,
};

module.exports = config;
