import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// The UI renders conditionally instead of hiding with CSS, so *ByRole can skip the costly
// computed-style visibility walk on large forms (the Advanced panel has 100+ fields).
configure({ defaultHidden: true });

afterEach(() => {
  cleanup();
});
