import { deriveClassFromEmail, deriveFromGradYear, emailGradYear } from "./classFromEmail";

test("parses NU email class years", () => {
  expect(emailGradYear("name2028@u.northwestern.edu")).toBe(2028);
  expect(emailGradYear("name2028@northwestern.edu")).toBe(2028);
  expect(emailGradYear("name@u.northwestern.edu")).toBeNull();
});

test("maps Fall 2026 standings from graduation year", () => {
  const asOf = new Date("2026-11-20");
  expect(deriveFromGradYear(2027, asOf)).toEqual({ standing: "Senior", graduation_year: "2027" });
  expect(deriveFromGradYear(2028, asOf)).toEqual({ standing: "Junior", graduation_year: "2028" });
  expect(deriveFromGradYear(2026, asOf)).toEqual({ standing: "Alumni", graduation_year: "2026" });
  expect(deriveClassFromEmail("max2029@u.northwestern.edu", asOf)?.standing).toBe("Sophomore");
});
