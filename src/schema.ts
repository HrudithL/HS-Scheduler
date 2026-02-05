import { z } from "zod";

/**
 * Normalizes various forms of "N/A" to a consistent "n/a"
 */
export function normalizeNA(value: string | null | undefined): string {
  if (!value || value.trim() === "") return "n/a";
  const normalized = value.trim();
  if (normalized.toLowerCase() === "n/a" || normalized === "-") return "n/a";
  return normalized;
}

/**
 * Parses credit strings like "0.5" or "0.5 credits" to a number
 */
export function parseCredits(value: string | null | undefined): number {
  if (!value) return 0;
  const match = value.toString().match(/(\d+\.?\d*)/);
  return match ? parseFloat(match[1]) : 0;
}

/**
 * Parses grade strings like "9th, 10th, 11th, 12th" into an array
 */
export function parseGrades(value: string | null | undefined): string[] {
  if (!value || value.trim() === "" || normalizeNA(value) === "n/a") {
    return [];
  }
  return value
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
}

/**
 * Cleans description text by normalizing Unicode and removing replacement characters
 */
export function cleanDescription(value: string | null | undefined): string {
  if (!value) return "n/a";
  
  // Normalize Unicode to NFC form
  let cleaned = value.normalize("NFC");
  
  // Remove Unicode replacement characters (U+FFFD)
  cleaned = cleaned.replace(/\uFFFD/g, "");
  
  // Remove other common problematic characters
  cleaned = cleaned.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  
  // Normalize whitespace
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  
  return cleaned || "n/a";
}

/**
 * Calculates GPA based on course name and tags
 * - AP or KAP courses (in name or tags) → 5.0 GPA
 * - Dual Credit courses (name contains "Dual Credit" or tag "DC") → 4.5 GPA
 * - All other courses → 4.0 GPA
 */
export function calculateGPA(courseName: string, tags: string[]): number {
  const nameUpper = courseName.toUpperCase();
  const tagsUpper = tags.map(t => t.toUpperCase());
  
  // Check for AP or KAP in course name or tags
  if (nameUpper.includes("AP") || nameUpper.includes("KAP") ||
      tagsUpper.includes("AP") || tagsUpper.includes("KAP")) {
    return 5.0;
  }
  
  // Check for Dual Credit in course name or "DC" tag
  if (nameUpper.includes("DUAL CREDIT") || tagsUpper.includes("DC")) {
    return 4.5;
  }
  
  // Default GPA for regular courses
  return 4.0;
}

/**
 * Zod schema for a single course (without source - moved to catalog level)
 */
export const CourseSchema = z.object({
  courseCode: z.string().min(1),
  courseName: z.string().min(1),
  credits: z.number(),
  tags: z.array(z.string()),
  gpa: z.number(),
  
  subject: z.string(),
  term: z.string(),
  eligibleGrades: z.array(z.string()),
  prerequisite: z.string(),
  corequisite: z.string(),
  enrollmentNotes: z.string(),
  courseDescription: z.string(),
});

export type Course = z.infer<typeof CourseSchema>;

/**
 * Zod schema for the entire course catalog with source metadata
 */
export const CourseCatalogSchema = z.object({
  source: z.object({
    district: z.string(),
    url: z.string().url(),
  }),
  courses: z.array(CourseSchema),
});

export type CourseCatalog = z.infer<typeof CourseCatalogSchema>;

/**
 * Creates a course object with normalized fields
 */
export function createCourse(data: {
  courseCode: string;
  courseName: string;
  credits: string | number;
  tags: string[];
  subject?: string;
  term?: string;
  eligibleGrades?: string | string[];
  prerequisite?: string;
  corequisite?: string;
  enrollmentNotes?: string;
  courseDescription?: string;
}): Course {
  const courseName = data.courseName.trim();
  return {
    courseCode: data.courseCode.trim(),
    courseName: courseName,
    credits: typeof data.credits === "number" ? data.credits : parseCredits(data.credits),
    tags: data.tags,
    gpa: calculateGPA(courseName, data.tags),
    subject: normalizeNA(data.subject),
    term: normalizeNA(data.term),
    eligibleGrades: Array.isArray(data.eligibleGrades) 
      ? data.eligibleGrades 
      : parseGrades(data.eligibleGrades),
    prerequisite: normalizeNA(data.prerequisite),
    corequisite: normalizeNA(data.corequisite),
    enrollmentNotes: normalizeNA(data.enrollmentNotes),
    courseDescription: cleanDescription(data.courseDescription),
  };
}

