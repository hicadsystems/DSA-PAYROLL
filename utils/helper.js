export function toSlug(str) {
  return str
    .toLowerCase()
    .trim()
    .replace(/\//g, "-")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

export function generateMessageId() {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

export function getContactPhone(contact) {
  const phones = {
    admin: "+234-xxx-xxx-1",
    payroll: "+234-xxx-xxx-2",
    technical: "+234-xxx-xxx-3",
    general: "+234-xxx-xxx-4",
  };
  return phones[contact] || null;
}
