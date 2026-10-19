import type { QuestionBank } from "../bank.ts";

/** Hobbies and what the person is into lately: facts and "currently…" memories. */
export const LIFE_V1: QuestionBank = {
  id: "life-v1",
  sections: [
    { id: "fun", title: "For fun", questions: [{ id: "fun.hobbies", text: "What do you do for fun?", feeds: ["fact"] }] },
    {
      id: "interests",
      title: "Interests",
      repeat: { label: "Interest", copies: 3 },
      questions: [
        { id: "interests.name", text: "An interest or hobby.", feeds: ["fact"] },
        { id: "interests.depth", text: "How long have you been into it, and how deep?", feeds: ["fact"] },
        { id: "interests.now", text: "Anything in it you're into right now (reading, playing, watching)?", feeds: ["current"] },
      ],
    },
    {
      id: "share",
      title: "To share",
      questions: [
        { id: "share.recommend", text: "What would you recommend to a friend right now (a book, game, place)?", feeds: ["stance", "current"] },
        { id: "share.fact", text: "A fun fact about you that you're happy to share.", feeds: ["fact"] },
      ],
    },
  ],
};
