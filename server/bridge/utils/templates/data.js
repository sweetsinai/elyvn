/**
 * Niche template data — barrel file.
 *
 * Assembles per-category niche files into NICHE_TEMPLATES + INDUSTRY_MAP.
 * Consumed by ../nicheTemplates.js which exposes the public API.
 *
 * To add/edit niches, update the relevant category file:
 *   niches-health-beauty.js  — dental, medspa, salon, gym, veterinary
 *   niches-home-services.js  — hvac, plumbing, electrical, auto
 *   niches-professional.js   — realestate, legal
 */

const healthBeauty = require('./niches-health-beauty');
const homeServices = require('./niches-home-services');
const professional = require('./niches-professional');

const NICHE_TEMPLATES = { ...healthBeauty, ...homeServices, ...professional };

// Map free-text industry strings to NICHE_TEMPLATES keys
const INDUSTRY_MAP = {
  'dental': 'dental',
  'dental clinic': 'dental',
  'dentist': 'dental',
  'med spa': 'medspa',
  'medspa': 'medspa',
  'aesthetics': 'medspa',
  'salon': 'salon',
  'salon / barbershop': 'salon',
  'barbershop': 'salon',
  'hair salon': 'salon',
  'hvac': 'hvac',
  'heating': 'hvac',
  'cooling': 'hvac',
  'plumbing': 'plumbing',
  'plumber': 'plumbing',
  'electrical': 'electrical',
  'electrician': 'electrical',
  'real estate': 'realestate',
  'realtor': 'realestate',
  'legal': 'legal',
  'law firm': 'legal',
  'attorney': 'legal',
  'lawyer': 'legal',
  'gym': 'gym',
  'gym / fitness': 'gym',
  'fitness': 'gym',
  'veterinary': 'veterinary',
  'vet': 'veterinary',
  'pet care': 'veterinary',
  'auto repair': 'auto',
  'auto': 'auto',
  'mechanic': 'auto',
  'car repair': 'auto',
};

module.exports = { NICHE_TEMPLATES, INDUSTRY_MAP };
