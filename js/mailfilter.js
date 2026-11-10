// Tri des mails marqués d'un drapeau : seuls ceux qui appellent une réponse deviennent des tâches.
// Les mails promotionnels (lettres d'information, offres, webinaires…) et automatiques (commandes,
// factures, codes, notifications…) sont ignorés. Tri par mots-clés sur l'objet et le début du message.

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const PROMO = [
  /newsletter|lettre d.information|la lettre\b|edition (?:de|du|n)/,
  /\bpromo|offre (?:speciale|exclusive|limitee|du moment)|code promo|bon plan|soldes|black friday|cyber monday|\d+ ?% (?:de reduction|offerts?|off)|-\d+ ?%|reduction|remise exceptionnelle/,
  /\bwebinai?re?\b|\bwebinar|masterclass|keynote|live (?:gratuit|exclusif)|replay|inscrivez-vous|reservez votre place|derniere chance|ne manquez pas|decouvrez|nouveaute|nouvelle collection|en avant-premiere/,
  /se desinscrire|se desabonner|desinscription|unsubscribe|gerer vos preferences|vous recevez ce (?:mail|message)/,
  /\bvente privee|cadeau offert|livraison offerte|essai gratuit|gratuitement pendant/,
];
const AUTO = [
  /\bno-?reply|ne pas repondre|ne repondez pas|message automatique|ceci est un (?:mail|message) automatique|notification automatique/,
  /votre commande|confirmation de (?:commande|paiement|reservation|rendez-vous|votre inscription)|commande n|expedi|colis|livraison prevue|suivi de (?:votre )?(?:colis|commande)/,
  /\bfacture (?:n|disponible|du|de)|votre facture|recu de paiement|avis de paiement|prelevement|echeancier|releve de (?:compte|carte)|avis d.echeance/,
  /code de (?:verification|confirmation|securite)|mot de passe|reinitialis|connexion (?:inhabituelle|detectee)|nouvelle connexion|verifiez votre (?:adresse|compte)|activez votre compte|authentification/,
  /\balerte\b|rappel automatique|accuse de reception|votre (?:abonnement|compte) (?:a ete|est)|mise a jour de (?:nos|vos) conditions|politique de confidentialite/,
];
const REPLY = [
  /^(?:re|r|tr|fw|fwd)\s*:/,
  /\?/,
  /pouvez-vous|pourriez-vous|pourrais-tu|peux-tu|merci de (?:me|nous|bien vouloir)|j.ai besoin|nous avons besoin|votre avis|votre retour|vos disponibilites|ta disponibilite|quand (?:pouvez|peux)|serait-il possible|est-il possible|a valider|pour validation|en attente de votre|relance|urgent|sans reponse|merci de confirmer/,
  /demande de (?:devis|rendez-vous|formation|renseignements?|information|rdv)|\bdevis\b|proposition commerciale|convention de formation|candidature|dossier (?:de|a)/,
];

/** { kind: 'reponse' | 'promo' | 'auto', reason } */
export function classifyMail(subject, preview = '') {
  const sub = norm(subject), txt = norm(`${subject}\n${String(preview).slice(0, 1500)}`);
  const hit = (list, s) => list.find((r) => r.test(s));
  const reply = hit(REPLY, sub) || hit(REPLY.slice(2), txt);
  const promo = hit(PROMO, txt);
  const auto = hit(AUTO, txt);
  // Une vraie réponse (RE:, question) l'emporte sur un pied de page de désinscription ;
  // mais une offre ou un message automatique sans signe de demande est ignoré.
  if (reply && (/^(?:re|r|tr|fw|fwd)\s*:/.test(sub) || (!promo && !auto) || (!hit(PROMO.slice(0, 3), txt) && !hit(AUTO, sub)))) return { kind: 'reponse', reason: '' };
  if (auto) return { kind: 'auto', reason: 'message automatique' };
  if (promo) return { kind: 'promo', reason: 'promotionnel' };
  return { kind: 'reponse', reason: '' };
}

/** Texte brut d'un corps HTML ou texte (To Do). */
export const plainText = (body) => String(body?.content || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
