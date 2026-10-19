import type { QuestionBank } from "../bank.ts";

/** Program and coursework: what a background implies, and how deep each course went. */
export const EDUCATION_V1: QuestionBank = {
  id: "education-v1",
  sections: [
    {
      id: "program",
      title: "Program",
      questions: [
        { id: "program.current", text: "Which program are you in (or did you finish), at which school, and what year?", feeds: ["fact"] },
      ],
    },
    {
      id: "courses",
      title: "Courses",
      repeat: { label: "Course", copies: 3 },
      questions: [
        { id: "courses.name", text: "Which course?", feeds: ["fact"] },
        { id: "courses.covered", text: "What did it cover?", feeds: ["competence"] },
        { id: "courses.depth", text: "How deep did you go? Did you just pass, or could you teach parts of it?", feeds: ["competence"] },
        { id: "courses.built", text: "Anything you built or wrote for it?", feeds: ["fact", "competence"] },
      ],
    },
    {
      id: "beyond",
      title: "Beyond classes",
      questions: [{ id: "beyond.self", text: "What did you learn outside of classes (research, clubs, self-study)?", feeds: ["competence"] }],
    },
  ],
};
