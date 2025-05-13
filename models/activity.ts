// src/models/activity.ts
export interface ActivityData {
  // Include all common properties
  id?: string | null;
  name?: string | null;
  description?: string | null;
  photo?: string | null;
  academicYear?: string | null;
  category?: string | null;
  isPreSignup?: boolean | null;
  isStudentLed?: boolean | null;
  materials?: any[];
  poorWeatherPlan?: string | null;
  requirements?: any[];
  schedule?: string | null;
  semesterCost?: string | null;
  staff?: string[];
  staffForReports?: string[];
  studentLeaders?: string[];
  // Cache-related properties
  lastCheck?: string;
  error?: string;
  source?: string;
  cache?: string;
  [key: string]: any; // Allow additional properties
}