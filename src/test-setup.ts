import '@testing-library/jest-dom';

// Ensure localStorage works for Zustand persist middleware in jsdom
// In some jsdom versions the Storage prototype methods are not callable.
const _store: Record<string, string> = {};
const storageMock: Storage = {
  getItem: (key: string) => _store[key] ?? null,
  setItem: (key: string, value: string) => { _store[key] = value; },
  removeItem: (key: string) => { delete _store[key]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
  get length() { return Object.keys(_store).length; },
  key: (i: number) => Object.keys(_store)[i] ?? null,
};
Object.defineProperty(globalThis, 'localStorage', { value: storageMock, writable: true });