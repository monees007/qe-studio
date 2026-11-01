import { create } from 'zustand';
import type { AIContextItem, Structure } from '../api/types';

/** Cross-page working state (the "workbench"). */
interface WorkbenchState {
  /** Structure currently open in the structure editor (unsaved working copy). */
  structure: Structure | null;
  structureId: string | null; // library id if it came from / was saved to the library
  structureName: string;
  setStructure: (s: Structure | null, id?: string | null, name?: string) => void;

  /** Input currently open in the input editor. */
  inputText: string;
  inputProgram: string;
  inputDocId: string | null;
  inputName: string;
  setInput: (text: string, program?: string, docId?: string | null, name?: string) => void;

  /** AI drawer */
  aiOpen: boolean;
  aiContext: AIContextItem[];
  aiPrompt: string;
  openAI: (context?: AIContextItem[], prompt?: string) => void;
  closeAI: () => void;
  setAIContext: (c: AIContextItem[]) => void;
}

export const useWorkbench = create<WorkbenchState>((set) => ({
  structure: null,
  structureId: null,
  structureName: 'untitled',
  setStructure: (s, id, name) =>
    set((st) => ({
      structure: s,
      structureId: id === undefined ? st.structureId : id,
      structureName: name ?? s?.name ?? st.structureName,
    })),

  inputText: '',
  inputProgram: 'pw',
  inputDocId: null,
  inputName: 'untitled.in',
  setInput: (text, program, docId, name) =>
    set((st) => ({
      inputText: text,
      inputProgram: program ?? st.inputProgram,
      inputDocId: docId === undefined ? st.inputDocId : docId,
      inputName: name ?? st.inputName,
    })),

  aiOpen: false,
  aiContext: [],
  aiPrompt: '',
  openAI: (context, prompt) => set({ aiOpen: true, aiContext: context ?? [], aiPrompt: prompt ?? '' }),
  closeAI: () => set({ aiOpen: false }),
  setAIContext: (c) => set({ aiContext: c }),
}));
