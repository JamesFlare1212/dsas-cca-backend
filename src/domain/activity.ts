export interface Meeting {
  day: string | null;
  startTime: string | null;
  endTime: string | null;
  location: {
    block: string | null;
    room: string | null;
    site: string | null;
  };
}

export interface ActivityMeeting extends Meeting {
  staff: string[];
}

export interface Activity {
  id: string;
  name: string;
  academicYear: string | null;
  category: string | null;
  description: string | null;
  descriptionZh: string | null;
  photo: string | null;
  duration: {
    startDate: string | null;
    endDate: string | null;
    isRecurringWeekly: boolean | null;
  };
  grades: {
    /** Numeric strings: KG1=-2, KG2=-1, KG3=0; G1 through G12 keep their numbers. */
    min: string | null;
    max: string | null;
  };
  isPreSignup: boolean | null;
  isStudentLed: boolean | null;
  materials: string[];
  meeting: Meeting;
  meetings: ActivityMeeting[];
  poorWeatherPlan: string | null;
  schedule: string | null;
  semesterCost: string | null;
  requirements: string[];
  staff: string[];
  staffForReports: string[];
  studentLeaders: string[];
}

export type StaffDirectory = Record<string, string>;
