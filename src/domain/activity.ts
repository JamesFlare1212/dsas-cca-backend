export interface Activity {
  id: string;
  name: string;
  academicYear: string | null;
  category: string | null;
  description: string | null;
  photo: string | null;
  duration: {
    startDate: string | null;
    endDate: string | null;
    isRecurringWeekly: boolean | null;
  };
  grades: {
    min: string | null;
    max: string | null;
  };
  isPreSignup: boolean | null;
  isStudentLed: boolean | null;
  materials: string[];
  meeting: {
    day: string | null;
    startTime: string | null;
    endTime: string | null;
    location: {
      block: string | null;
      room: string | null;
      site: string | null;
    };
  };
  poorWeatherPlan: string | null;
  schedule: string | null;
  semesterCost: string | null;
  requirements: string[];
  staff: string[];
  staffForReports: string[];
  studentLeaders: string[];
}

export type StaffDirectory = Record<string, string>;
