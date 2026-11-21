/** Map NU email class year (...YYYY@u.northwestern.edu) to standing / graduation year. */

export function emailGradYear(email: unknown): number | null {
  if (typeof email !== "string") return null;
  const match = email.trim().toLowerCase().match(/(20\d{2})@(?:u\.)?northwestern\.edu$/);
  return match ? Number(match[1]) : null;
}

export function deriveFromGradYear(gradYear: number, asOf: Date = new Date()) {
  const academicStartYear = asOf.getMonth() >= 7 ? asOf.getFullYear() : asOf.getFullYear() - 1;
  const seniorClass = academicStartYear + 1;
  const delta = gradYear - seniorClass;
  if (delta < 0) return { standing: "Alumni", graduation_year: String(gradYear) };
  if (delta === 0) return { standing: "Senior", graduation_year: String(gradYear) };
  if (delta === 1) return { standing: "Junior", graduation_year: String(gradYear) };
  if (delta === 2) return { standing: "Sophomore", graduation_year: String(gradYear) };
  return { standing: "Freshman", graduation_year: String(gradYear) };
}

export function deriveClassFromEmail(email: unknown, asOf: Date = new Date()) {
  const year = emailGradYear(email);
  return year == null ? null : deriveFromGradYear(year, asOf);
}
