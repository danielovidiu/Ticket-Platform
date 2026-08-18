// Named by `test.setupFiles` in vite.config.mjs. react-scripts used to find this
// by convention; Vitest has no such convention, so deleting it now fails loudly
// rather than silently dropping the matchers below from every test.
//
// `@testing-library/jest-dom` adds the DOM matchers the tests read with — toBeVisible,
// toBeDisabled, toHaveTextContent — which say what they mean far better than poking at
// element properties by hand.
import "@testing-library/jest-dom";
