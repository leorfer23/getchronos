// The Fleet board's running order: one name per widget, top to bottom, exactly as the operator
// should read them. A name here is a module at ./<name>.js and a reader of the same name in
// src/widgets/index.ts — the board mounts what is in BOTH lists and says nothing about the rest.
//
// ADD ONE STRING. Nothing else in this file ever changes, which is what keeps four widgets landing
// the same week from fighting over it.
export const WIDGETS = ["pulse", "decide", "robert", "shipped"];
