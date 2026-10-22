// Older records have no availability field and remain ready to wear.
export const garmentAvailability = item => item?.availability === 'laundry' ? 'laundry' : 'ready';
export const inLaundry = item => garmentAvailability(item) === 'laundry';
