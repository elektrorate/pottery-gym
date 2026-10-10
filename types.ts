
export enum AppView {
  CALENDAR = 'calendar',
  STUDENTS = 'students',
  PIECES = 'pieces',
  GIFTCARDS = 'giftcards',
  DASHBOARD = 'dashboard',
  SETTINGS = 'settings',
  HISTORY = 'history',
  INVENTORY = 'inventory',
  TEACHERS = 'teachers',
  TEAM = 'team'
}

export interface AssignedClass {
  date: string;
  startTime: string;
  endTime: string;
  status?: 'present' | 'absent' | 'pending';
}

export type MembershipTier = 'plata' | 'gold' | 'platinum';

export const MEMBERSHIP_PLANS: Record<MembershipTier, { label: string; price: number; bonuses: number }> = {
  plata: { label: 'Plata', price: 90, bonuses: 3 },
  gold: { label: 'Gold', price: 120, bonuses: 4 },
  platinum: { label: 'Platinum', price: 180, bonuses: 8 }
};

export const inferMembershipTier = (tier?: string, price?: number): MembershipTier => {
  if (tier === 'plata' || tier === 'gold' || tier === 'platinum') return tier;
  if (price === MEMBERSHIP_PLANS.plata.price) return 'plata';
  if (price === MEMBERSHIP_PLANS.platinum.price) return 'platinum';
  return 'gold';
};

export interface Student {
  id: string;
  name: string;
  surname?: string;
  email?: string;
  phone: string;
  phoneCountry?: string;
  birthDay?: string;
  birthMonth?: string;
  birthYear?: string;
  classesRemaining: number;
  status: 'membresia' | 'needs_renewal' | 'new' | 'active';
  paymentStatus?: 'paid' | 'pending';
  paymentMethod?: string;
  notes?: string;
  observations?: string;
  price?: number;
  assignedClasses?: AssignedClass[];
  classType?: string;
  expiryDate?: string;
  studentCategory?: 'membresia' | 'temporal';
  membershipTier?: MembershipTier;
  membershipActivatedAt?: string;
  archivedAt?: string;
  groupName?: string;
  bonosAsignados?: number;
  repetirMensualmente?: boolean;
  createdAt?: string;
}

export interface ClassSession {
  id: string;
  date: string; // ISO format
  startTime: string;
  endTime: string;
  classType: 'mesa' | 'torno' | 'coworking' | 'workshop' | 'privada' | 'feriado';
  capacity?: number;
  students: string[]; // List of student names
  attendance?: Record<string, 'present' | 'absent'>; // Record key is student name or ID
  studentIds?: string[];
  attendanceByStudentId?: Record<string, 'present' | 'absent'>;
  giftCardIdByStudentId?: Record<string, string>;
  teacherId?: string;
  teacherSubstituteId?: string;
  completedAt?: string;
  workshopName?: string;
  privateReason?: string;
  sessionAudience?: 'membresia' | 'temporal' | 'ambos'; // Audiencia: membresía (permanentes), temporal, o ambos
}

export const getDefaultSessionCapacity = (classType: ClassSession['classType']): number =>
  classType === 'torno' ? 5 : 8;

export interface WorkshopScheduleDay {
  id?: string;
  dayOfWeek: number; // JavaScript day: 0 Sunday through 6 Saturday
  slotIndex: number;
  isOpen: boolean;
  opensAt: string;
  closesAt: string;
}

export interface Teacher {
  id: string;
  name: string;
  surname?: string;
  email?: string;
  phone?: string;
  specialty?: string;
  notes?: string;
}

export type PieceStatus = '1era_quema' | 'esmaltado' | 'a_recogida' | 'entregado';

export interface CeramicPiece {
  id: string;
  owner: string;
  description: string;
  status: PieceStatus;
  glazeType?: string;
  deliveryDate?: string; // ISO date string
  notes?: string;
  extraCommentary?: string;
  createdAt?: string; // ISO timestamp
}

export interface GiftCard {
  id: string;
  code?: string;
  buyer: string;
  buyerPhone?: string;
  buyerEmail?: string;
  recipient: string;
  recipientEmail?: string;
  recipientStudentId?: string;
  numClasses: number;
  type: 'modelado' | 'torno';
  validityMonths?: 3 | 6 | 8;
  activatedAt?: string;
  issuedDate?: string;
  expiryDate?: string;
  price?: number;
  paymentStatus?: 'pending' | 'paid' | 'refunded';
  status?: 'pending' | 'active' | 'exhausted' | 'consumed' | 'expired' | 'cancelled';
  sessionsUsed?: number;
  sessionsRemaining?: number;
  consumedAt?: string;
  deliveryFormat?: 'digital' | 'physical';
  dedication?: string;
  movements?: GiftCardMovement[];
  createdAt: string; // ISO format
  extraCommentary?: string;
}

export interface GiftCardMovement {
  id: string;
  giftCardId: string;
  sessionId?: string;
  studentId?: string;
  type: 'redeem' | 'reverse' | 'manual' | 'cancel';
  sessionsDelta: number;
  note?: string;
  createdAt: string;
}

// --- INVENTORY TYPES ---

export type InventoryCategory = 'glaze' | 'clay' | 'engobe' | 'oxide' | 'raw_material';
export type InventoryItemStatus = 'active' | 'archived';
export type MovementType = 'in' | 'out' | 'adjust';
export type ColorFamily = 'blancos' | 'negros' | 'azules' | 'verdes' | 'tierras' | 'transparentes' | 'efectos' | 'otros';
export type GlazeFinish = 'mate' | 'satinado' | 'brillo';

export interface InventoryMovement {
  id: string;
  item_id: string;
  type: MovementType;
  quantity?: number;
  new_quantity?: number; // Para ajustes absolutos
  unit: string;
  reason: string;
  date: string;
  notes?: string;
}

export interface FormulaComponent {
  name: string;
  percentage: number;
}

export interface StructuredFormula {
  recipe: FormulaComponent[]; // Bloque A: 100%
  additives: FormulaComponent[]; // Bloque B: extras
  colorants: FormulaComponent[]; // Bloque C: extras
}

export interface InventoryItem {
  id: string;
  category: InventoryCategory;
  name: string;
  code: string;
  unit: string;
  current_quantity: number;
  min_quantity?: number;
  location?: string;
  supplier?: string;
  supplier_code?: string;
  cost_per_unit?: number;
  notes?: string;
  created_at: string;
  updated_at: string;
  status: InventoryItemStatus;

  // Específicos Esmaltes y Engobes
  formula_unit?: 'percent' | 'weight';
  formula?: StructuredFormula;
  firing_range?: string;
  surface?: string;
  color?: string;
  color_family?: ColorFamily;
  finish?: GlazeFinish;
  test_tile_reference?: string;
  hazard_notes?: string;
  state?: string;

  // Específicos Pastas
  clay_type?: string;
  cone_or_temp?: string;
  body_notes?: string;
  unit_weight?: number; // Peso unitario por pella/bolsa en kg

  // Específicos Engobes
  engobe_base?: string;

  // Específicos Óxidos
  chemical_name?: string;
  purity?: string;

  // Específicos Otros
  material_type?: string;
}
