//! Realm Ledger onchain referee.
//!
//! What lives here (see DESIGN.md, "Fair play: what the chain proves" and "Agent economy"):
//! - Campaigns, with commitments to the map seed, the battle-roll secret and each
//!   ruler's secret agenda, all checked at the end.
//! - Sealed orders: every ruler posts sha256(canonical orders JSON | salt) each season,
//!   then reveals; the contract checks each reveal against its seal and logs the orders.
//! - Realm treasuries (in crowns), moved by the referee from the rules engine's
//!   resolution, and spent by agents within contract-enforced policies.
//! - Treaties signed by both rulers' accounts.
//! - Agent hires held in escrow and paid only when the work is delivered and checked,
//!   with a receipt event for every spend.
//! - Agent accounts: sub-accounts whose only key is a function-call key limited to
//!   this contract and a fixed list of methods.
//!
//! The rules (battles, prices) are not computed here; they are deterministic in
//! packages/rules and anyone can replay them from what this contract records.

use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, NearToken, PanicOnDefault, Promise, PublicKey};

#[cfg(test)]
mod tests;

/// Methods an agent's function-call key may call.
pub const AGENT_METHODS: &str = "seal,reveal,propose_treaty,accept_treaty,set_policy,hire,deliver,settle_job";
/// Gas allowance on each agent key. When it runs out the agent can't sign; a new key is needed.
pub const AGENT_GAS_ALLOWANCE: NearToken = NearToken::from_millinear(500);
const MAX_ORDERS_JSON: usize = 8_000;
const MAX_TEXT: usize = 1_000;
const MAX_REALMS: usize = 8;

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// rulers post seals for the current season
    Sealing,
    /// seals are closed; rulers (or the referee for them) reveal
    Revealing,
    /// every season is settled; waiting for the final reveal
    Ended,
    /// final reveal checked
    Finished,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Realm {
    pub ruler: AccountId,
    pub chancellor: Option<AccountId>,
    pub treasury: u64,
    pub alive: bool,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TreatyKind {
    Peace,
    Passage,
    Trade,
    Alliance,
    Tribute,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Treaty {
    pub id: u32,
    pub kind: TreatyKind,
    /// [proposer realm, other realm]
    pub realms: [u8; 2],
    /// tribute: crowns per season from realms[0] to realms[1]
    pub amount: u64,
    pub proposed_season: u32,
    pub signed_season: Option<u32>,
    pub broken_season: Option<u32>,
    pub broken_by: Option<u8>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Campaign {
    pub id: u64,
    pub referee: AccountId,
    pub map_seed: String,
    /// sha256(canonical roll secret JSON | salt), hex
    pub roll_commit: String,
    /// one per realm: sha256(canonical agenda JSON | salt), hex
    pub agenda_commits: Vec<String>,
    pub realms: Vec<Realm>,
    pub max_seasons: u32,
    pub season: u32,
    pub phase: Phase,
    pub season_ms: u64,
    /// seals close at this time even if some rulers haven't sealed
    pub seal_deadline_ms: u64,
    pub sealed: Vec<bool>,
    pub revealed: Vec<bool>,
    /// rules-engine state hash after each settled season
    pub state_hashes: Vec<String>,
    pub treaties: Vec<Treaty>,
    pub winner: Option<u8>,
    pub roll_secret: Option<String>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct SealRecord {
    pub seal: String,
    pub revealed: bool,
}

/// A season's revealed orders, kept until the season settles so the referee can resolve it
/// even if the browser that revealed them never told the game server.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RevealedOrders {
    pub orders: String,
    pub salt: String,
}

// Per-season records kept under their own storage prefixes (outside the contract state
// struct, so adding them needed no state migration) and removed when the season settles.
const REVEAL_PREFIX: u8 = b'o';
const FORFEIT_PREFIX: u8 = b'f';

fn season_key(prefix: u8, campaign: u64, season: u32, realm: u8) -> Vec<u8> {
    let mut k = vec![prefix];
    k.extend_from_slice(&campaign.to_le_bytes());
    k.extend_from_slice(&season.to_le_bytes());
    k.push(realm);
    k
}

/// How much an agent may spend from its realm's treasury.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct Policy {
    pub season_cap: u64,
    pub campaign_cap: u64,
    pub spent_season: u64,
    /// the season `spent_season` refers to
    pub season: u32,
    pub spent_total: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JobKind {
    Mercenary,
    Spy,
    Envoy,
    Supply,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JobStatus {
    Hired,
    Delivered,
    Paid,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Job {
    pub id: u64,
    pub campaign: u64,
    pub realm: u8,
    /// the ruler or chancellor who hired
    pub buyer: AccountId,
    pub worker: AccountId,
    pub kind: JobKind,
    pub price: u64,
    pub spec: String,
    pub season: u32,
    pub status: JobStatus,
    /// sha256 of the delivered work (a spy's report, a march order), hex
    pub delivery: Option<String>,
    pub note: Option<String>,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct RealmInit {
    pub ruler: AccountId,
    pub chancellor: Option<AccountId>,
    pub treasury: u64,
    /// the ruler's own spending policy
    pub season_cap: u64,
    pub campaign_cap: u64,
}

#[near(event_json(standard = "realm-ledger"))]
pub enum Event {
    #[event_version("1.0.0")]
    CampaignCreated { campaign: u64, referee: AccountId, map_seed: String, roll_commit: String, agenda_commits: Vec<String> },
    #[event_version("1.0.0")]
    Sealed { campaign: u64, season: u32, realm: u8, seal: String },
    #[event_version("1.0.0")]
    Revealed { campaign: u64, season: u32, realm: u8, orders: String, salt: String },
    #[event_version("1.1.0")]
    SeasonSettled { campaign: u64, season: u32, state_hash: String, treasury_deltas: Vec<i64>, fallen: Vec<u8>, forfeited: Vec<u8> },
    #[event_version("1.0.0")]
    Forfeited { campaign: u64, season: u32, realm: u8 },
    #[event_version("1.0.0")]
    TreatyProposed { campaign: u64, treaty: u32, kind: TreatyKind, realms: [u8; 2], amount: u64 },
    #[event_version("1.0.0")]
    TreatySigned { campaign: u64, treaty: u32 },
    #[event_version("1.0.0")]
    TreatyBroken { campaign: u64, treaty: u32, by: u8, season: u32 },
    #[event_version("1.0.0")]
    PolicySet { campaign: u64, spender: AccountId, season_cap: u64, campaign_cap: u64 },
    #[event_version("1.0.0")]
    Hired { campaign: u64, job: u64, realm: u8, buyer: AccountId, worker: AccountId, kind: JobKind, price: u64, spec: String },
    #[event_version("1.0.0")]
    Delivered { campaign: u64, job: u64, delivery: String },
    #[event_version("1.0.0")]
    Receipt { campaign: u64, job: u64, realm: u8, buyer: AccountId, worker: AccountId, kind: JobKind, price: u64, passed: bool, note: String },
    #[event_version("1.0.0")]
    CampaignFinished { campaign: u64, winner: u8, roll_secret: String, agendas: Vec<String> },
    #[event_version("1.0.0")]
    AgentCreated { account: AccountId },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct RealmLedger {
    owner: AccountId,
    referees: LookupSet<AccountId>,
    campaigns: LookupMap<u64, Campaign>,
    next_campaign: u64,
    /// key: (campaign, season, realm)
    seals: LookupMap<(u64, u32, u8), SealRecord>,
    /// key: (campaign, spender)
    policies: LookupMap<(u64, AccountId), Policy>,
    jobs: LookupMap<u64, Job>,
    next_job: u64,
    /// crowns earned by worker agents, key: (campaign, worker)
    earnings: LookupMap<(u64, AccountId), u64>,
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// sha256("{value}|{salt}") as lowercase hex: the same commitment packages/rules makes
/// (`sealOrders`, `commit`), where `value` is canonical JSON.
pub fn commitment(value: &str, salt: &str) -> String {
    hex::encode(env::sha256_array(format!("{value}|{salt}").as_bytes()))
}

#[near]
impl RealmLedger {
    #[init]
    pub fn new(owner: AccountId) -> Self {
        Self {
            owner,
            referees: LookupSet::new(b"r"),
            campaigns: LookupMap::new(b"c"),
            next_campaign: 0,
            seals: LookupMap::new(b"s"),
            policies: LookupMap::new(b"p"),
            jobs: LookupMap::new(b"j"),
            next_job: 0,
            earnings: LookupMap::new(b"e"),
        }
    }

    // ---------- admin ----------

    pub fn add_referee(&mut self, account: AccountId) {
        self.only_owner();
        self.referees.insert(account);
    }

    pub fn remove_referee(&mut self, account: AccountId) {
        self.only_owner();
        self.referees.remove(&account);
    }

    /// Creates `{name}.{this contract}` whose only key is a function-call key for this
    /// contract's agent methods. The attached deposit funds the new account.
    #[payable]
    pub fn create_agent(&mut self, name: String, public_key: PublicKey) -> Promise {
        self.only_owner();
        require!(!name.is_empty() && !name.contains('.'), "agent name must be one label");
        let account: AccountId = format!("{name}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("invalid agent name"));
        Event::AgentCreated { account: account.clone() }.emit();
        Promise::new(account)
            .create_account()
            .transfer(env::attached_deposit())
            .add_access_key_allowance(
                public_key,
                near_sdk::Allowance::limited(AGENT_GAS_ALLOWANCE).unwrap(),
                env::current_account_id(),
                AGENT_METHODS,
            )
    }

    // ---------- campaign lifecycle ----------

    pub fn create_campaign(
        &mut self,
        realms: Vec<RealmInit>,
        map_seed: String,
        roll_commit: String,
        agenda_commits: Vec<String>,
        max_seasons: u32,
        season_ms: u64,
    ) -> u64 {
        let referee = env::predecessor_account_id();
        require!(self.referees.contains(&referee), "only an approved referee can create campaigns");
        require!(realms.len() >= 2 && realms.len() <= MAX_REALMS, "2 to 8 realms");
        require!(agenda_commits.len() == realms.len(), "one agenda commitment per realm");
        require!(is_hex64(&roll_commit) && agenda_commits.iter().all(|c| is_hex64(c)), "commitments must be sha256 hex");
        require!(max_seasons > 0 && season_ms > 0, "bad timing");
        require!(map_seed.len() <= MAX_TEXT, "seed too long");
        let id = self.next_campaign;
        self.next_campaign += 1;
        let n = realms.len();
        for r in &realms {
            self.policies.insert(
                (id, r.ruler.clone()),
                Policy { season_cap: r.season_cap, campaign_cap: r.campaign_cap, ..Default::default() },
            );
        }
        let campaign = Campaign {
            id,
            referee: referee.clone(),
            map_seed: map_seed.clone(),
            roll_commit: roll_commit.clone(),
            agenda_commits: agenda_commits.clone(),
            realms: realms
                .into_iter()
                .map(|r| Realm { ruler: r.ruler, chancellor: r.chancellor, treasury: r.treasury, alive: true })
                .collect(),
            max_seasons,
            season: 0,
            phase: Phase::Sealing,
            season_ms,
            seal_deadline_ms: env::block_timestamp_ms() + season_ms,
            sealed: vec![false; n],
            revealed: vec![false; n],
            state_hashes: vec![],
            treaties: vec![],
            winner: None,
            roll_secret: None,
        };
        self.campaigns.insert(id, campaign);
        Event::CampaignCreated { campaign: id, referee, map_seed, roll_commit, agenda_commits }.emit();
        id
    }

    /// Posts this season's commitment: sha256(canonical orders JSON | salt), hex.
    pub fn seal(&mut self, campaign: u64, realm: u8, seal: String) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        let c = self.campaign_mut(campaign);
        require!(c.phase == Phase::Sealing && now < c.seal_deadline_ms, "sealing is closed");
        let r = c.realms.get(realm as usize).unwrap_or_else(|| env::panic_str("no such realm"));
        require!(r.alive, "realm has fallen");
        require!(r.ruler == caller, "only the ruler seals its orders");
        require!(!c.sealed[realm as usize], "already sealed this season");
        require!(is_hex64(&seal), "seal must be sha256 hex");
        c.sealed[realm as usize] = true;
        let season = c.season;
        let all_sealed = c.realms.iter().zip(&c.sealed).all(|(r, s)| !r.alive || *s);
        if all_sealed {
            c.phase = Phase::Revealing;
        }
        self.seals.insert((campaign, season, realm), SealRecord { seal: seal.clone(), revealed: false });
        Event::Sealed { campaign, season, realm, seal }.emit();
    }

    /// Reveals a realm's orders. The ruler or the referee may submit it; either way it
    /// must match the seal. Opens once every living realm has sealed or the deadline passed.
    pub fn reveal(&mut self, campaign: u64, realm: u8, orders: String, salt: String) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        require!(orders.len() <= MAX_ORDERS_JSON && salt.len() <= 128, "reveal too large");
        let c = self.campaign_mut(campaign);
        if c.phase == Phase::Sealing && now >= c.seal_deadline_ms {
            c.phase = Phase::Revealing;
        }
        require!(c.phase == Phase::Revealing, "seals are not closed yet");
        let r = c.realms.get(realm as usize).unwrap_or_else(|| env::panic_str("no such realm"));
        require!(r.ruler == caller || c.referee == caller, "only the ruler or the referee reveals");
        require!(!c.revealed[realm as usize], "already revealed");
        c.revealed[realm as usize] = true;
        let season = c.season;
        require!(!env::storage_has_key(&season_key(FORFEIT_PREFIX, campaign, season, realm)), "this realm forfeited its orders this season");
        let key = (campaign, season, realm);
        let record = self.seals.get_mut(&key).unwrap_or_else(|| env::panic_str("this realm did not seal"));
        require!(commitment(&orders, &salt) == record.seal, "orders do not match the seal");
        record.revealed = true;
        env::storage_write(&season_key(REVEAL_PREFIX, campaign, season, realm), &near_sdk::serde_json::to_vec(&RevealedOrders { orders: orders.clone(), salt: salt.clone() }).unwrap());
        Event::Revealed { campaign, season, realm, orders, salt }.emit();
    }

    /// The ruler gives up this season's sealed orders, so the season can settle without
    /// them: for when the orders are lost. After this the realm can't reveal this season.
    pub fn forfeit(&mut self, campaign: u64, realm: u8) {
        let caller = env::predecessor_account_id();
        let c = self.campaign(campaign);
        require!(c.phase == Phase::Sealing || c.phase == Phase::Revealing, "this season is over");
        let r = c.realms.get(realm as usize).unwrap_or_else(|| env::panic_str("no such realm"));
        require!(r.ruler == caller, "only the ruler forfeits its orders");
        require!(c.sealed[realm as usize], "this realm did not seal");
        require!(!c.revealed[realm as usize], "already revealed");
        let season = c.season;
        let key = season_key(FORFEIT_PREFIX, campaign, season, realm);
        require!(!env::storage_has_key(&key), "already forfeited");
        env::storage_write(&key, &[1]);
        Event::Forfeited { campaign, season, realm }.emit();
    }

    /// The referee posts the result of resolving the season with packages/rules: the new
    /// state hash, each realm's treasury change, realms that fell and treaties broken.
    ///
    /// `forfeited` lists the sealed realms settled without their orders. Each must have sealed
    /// and not revealed, and either forfeited itself or waited out a full season after the
    /// seal deadline; every other sealed realm must have revealed. Without the list (older
    /// callers), it settles once every sealed realm revealed or a full season has passed.
    pub fn settle_season(
        &mut self,
        campaign: u64,
        state_hash: String,
        treasury_deltas: Vec<i64>,
        fallen: Vec<u8>,
        broken_treaties: Vec<(u32, u8)>,
        forfeited: Option<Vec<u8>>,
    ) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp_ms();
        require!(is_hex64(&state_hash), "state hash must be sha256 hex");
        let c = self.campaign_mut(campaign);
        require!(c.referee == caller, "only the referee settles");
        if c.phase == Phase::Sealing && now >= c.seal_deadline_ms {
            c.phase = Phase::Revealing;
        }
        require!(c.phase == Phase::Revealing, "seals are not closed yet");
        let window_closed = now >= c.seal_deadline_ms + c.season_ms;
        let n = c.realms.len();
        let forfeited = match forfeited {
            None => {
                let all_revealed = (0..n).all(|i| !c.sealed[i] || c.revealed[i]);
                require!(all_revealed || window_closed, "waiting for reveals");
                vec![]
            }
            Some(list) => {
                for &f in &list {
                    let i = f as usize;
                    require!(i < n, "no such realm");
                    require!(c.sealed[i] && !c.revealed[i], "a forfeited realm must have sealed and not revealed");
                    let declared = env::storage_has_key(&season_key(FORFEIT_PREFIX, campaign, c.season, f));
                    require!(declared || window_closed, "a realm can only be forfeited by its ruler or after the reveal window");
                }
                require!((0..n).all(|i| !c.sealed[i] || c.revealed[i] || list.contains(&(i as u8))), "waiting for reveals");
                list
            }
        };
        require!(treasury_deltas.len() == c.realms.len(), "one treasury delta per realm");

        for (realm, delta) in c.realms.iter_mut().zip(&treasury_deltas) {
            let t = realm.treasury as i128 + *delta as i128;
            require!(t >= 0, "treasury would go negative");
            realm.treasury = t as u64;
        }
        let season = c.season;
        for &f in &fallen {
            let r = c.realms.get_mut(f as usize).unwrap_or_else(|| env::panic_str("no such realm"));
            r.alive = false;
        }
        for &(id, by) in &broken_treaties {
            let t = c.treaties.iter_mut().find(|t| t.id == id).unwrap_or_else(|| env::panic_str("no such treaty"));
            require!(t.signed_season.is_some() && t.broken_season.is_none(), "treaty is not in force");
            require!(t.realms.contains(&by), "breaker is not party to the treaty");
            t.broken_season = Some(season);
            t.broken_by = Some(by);
            Event::TreatyBroken { campaign, treaty: id, by, season }.emit();
        }
        c.state_hashes.push(state_hash.clone());
        // this season's kept reveals and forfeits are no longer needed
        for i in 0..n as u8 {
            env::storage_remove(&season_key(REVEAL_PREFIX, campaign, season, i));
            env::storage_remove(&season_key(FORFEIT_PREFIX, campaign, season, i));
        }
        c.season += 1;
        c.sealed = vec![false; n];
        c.revealed = vec![false; n];
        let standing = c.realms.iter().filter(|r| r.alive).count();
        if c.season >= c.max_seasons || standing <= 1 {
            c.phase = Phase::Ended;
        } else {
            c.phase = Phase::Sealing;
            c.seal_deadline_ms = now + c.season_ms;
        }
        Event::SeasonSettled { campaign, season, state_hash, treasury_deltas, fallen, forfeited }.emit();
    }

    /// Final reveal: the battle-roll secret and every agenda, each checked against its
    /// commitment from campaign start. The referee may end early (by conquest) too.
    pub fn finish_campaign(
        &mut self,
        campaign: u64,
        winner: u8,
        roll_secret: String,
        roll_salt: String,
        agendas: Vec<(String, String)>,
    ) {
        let caller = env::predecessor_account_id();
        let c = self.campaign_mut(campaign);
        require!(c.referee == caller, "only the referee finishes a campaign");
        require!(c.phase != Phase::Finished, "already finished");
        require!((winner as usize) < c.realms.len(), "no such realm");
        require!(commitment(&roll_secret, &roll_salt) == c.roll_commit, "roll secret does not match its commitment");
        require!(agendas.len() == c.agenda_commits.len(), "one agenda per realm");
        for (i, (agenda, salt)) in agendas.iter().enumerate() {
            require!(commitment(agenda, salt) == c.agenda_commits[i], "an agenda does not match its commitment");
        }
        c.phase = Phase::Finished;
        c.winner = Some(winner);
        c.roll_secret = Some(roll_secret.clone());
        Event::CampaignFinished { campaign, winner, roll_secret, agendas: agendas.into_iter().map(|(a, _)| a).collect() }.emit();
    }

    // ---------- diplomacy ----------

    pub fn propose_treaty(&mut self, campaign: u64, from: u8, to: u8, kind: TreatyKind, amount: u64) -> u32 {
        let caller = env::predecessor_account_id();
        let c = self.campaign_mut(campaign);
        require!(matches!(c.phase, Phase::Sealing | Phase::Revealing), "campaign is over");
        require!(from != to, "a realm cannot treat with itself");
        let (a, b) = (
            c.realms.get(from as usize).unwrap_or_else(|| env::panic_str("no such realm")),
            c.realms.get(to as usize).unwrap_or_else(|| env::panic_str("no such realm")),
        );
        require!(a.alive && b.alive, "realm has fallen");
        require!(a.ruler == caller, "only the ruler proposes for its realm");
        require!(kind == TreatyKind::Tribute || amount == 0, "only tribute carries an amount");
        let id = c.treaties.len() as u32;
        c.treaties.push(Treaty {
            id,
            kind: kind.clone(),
            realms: [from, to],
            amount,
            proposed_season: c.season,
            signed_season: None,
            broken_season: None,
            broken_by: None,
        });
        Event::TreatyProposed { campaign, treaty: id, kind, realms: [from, to], amount }.emit();
        id
    }

    pub fn accept_treaty(&mut self, campaign: u64, treaty: u32) {
        let caller = env::predecessor_account_id();
        let c = self.campaign_mut(campaign);
        require!(matches!(c.phase, Phase::Sealing | Phase::Revealing), "campaign is over");
        let season = c.season;
        let t = c.treaties.get(treaty as usize).unwrap_or_else(|| env::panic_str("no such treaty")).clone();
        require!(t.signed_season.is_none(), "already signed");
        let other = &c.realms[t.realms[1] as usize];
        require!(other.alive && c.realms[t.realms[0] as usize].alive, "realm has fallen");
        require!(other.ruler == caller, "only the other ruler accepts");
        c.treaties[treaty as usize].signed_season = Some(season);
        Event::TreatySigned { campaign, treaty }.emit();
    }

    // ---------- agent economy ----------

    /// Sets a spender's policy. A ruler sets its own chancellor's; the referee sets any
    /// ruler's or chancellor's. Spent amounts so far are kept.
    pub fn set_policy(&mut self, campaign: u64, realm: u8, spender: AccountId, season_cap: u64, campaign_cap: u64) {
        let caller = env::predecessor_account_id();
        let c = self.campaign(campaign).clone();
        let r = c.realms.get(realm as usize).unwrap_or_else(|| env::panic_str("no such realm"));
        let is_chancellor = r.chancellor.as_ref() == Some(&spender);
        require!(spender == r.ruler || is_chancellor, "spender must be the realm's ruler or chancellor");
        let allowed = caller == c.referee || (caller == r.ruler && is_chancellor);
        require!(allowed, "only the ruler (for its chancellor) or the referee sets policy");
        let key = (campaign, spender.clone());
        let mut p = self.policies.get(&key).cloned().unwrap_or_default();
        p.season_cap = season_cap;
        p.campaign_cap = campaign_cap;
        self.policies.insert(key, p);
        Event::PolicySet { campaign, spender, season_cap, campaign_cap }.emit();
    }

    /// Hires a worker agent from the realm's treasury. The price goes into escrow and the
    /// spend counts against the buyer's policy.
    pub fn hire(&mut self, campaign: u64, realm: u8, worker: AccountId, kind: JobKind, price: u64, spec: String) -> u64 {
        let buyer = env::predecessor_account_id();
        require!(spec.len() <= MAX_TEXT, "spec too long");
        require!(price > 0, "price must be positive");
        let c = self.campaign(campaign).clone();
        require!(matches!(c.phase, Phase::Sealing | Phase::Revealing), "campaign is over");
        let season = c.season;
        let r = c.realms.get(realm as usize).unwrap_or_else(|| env::panic_str("no such realm"));
        require!(r.alive, "realm has fallen");
        require!(buyer == r.ruler || r.chancellor.as_ref() == Some(&buyer), "only the ruler or its chancellor spends");
        require!(worker != buyer && c.realms.iter().all(|x| x.ruler != worker), "a ruler cannot be hired");
        require!(r.treasury >= price, "treasury too low");

        let p = self
            .policies
            .get_mut(&(campaign, buyer.clone()))
            .unwrap_or_else(|| env::panic_str("no spending policy for this agent"));
        if p.season != season {
            p.season = season;
            p.spent_season = 0;
        }
        require!(p.spent_season + price <= p.season_cap, "over this season's spending cap");
        require!(p.spent_total + price <= p.campaign_cap, "over the campaign spending cap");
        p.spent_season += price;
        p.spent_total += price;

        self.campaign_mut(campaign).realms[realm as usize].treasury -= price;
        let id = self.next_job;
        self.next_job += 1;
        self.jobs.insert(
            id,
            Job {
                id,
                campaign,
                realm,
                buyer: buyer.clone(),
                worker: worker.clone(),
                kind: kind.clone(),
                price,
                spec: spec.clone(),
                season,
                status: JobStatus::Hired,
                delivery: None,
                note: None,
            },
        );
        Event::Hired { campaign, job: id, realm, buyer, worker, kind, price, spec }.emit();
        id
    }

    /// The worker marks the job done, with the hash of what it delivered.
    pub fn deliver(&mut self, job: u64, delivery: String) {
        let caller = env::predecessor_account_id();
        require!(is_hex64(&delivery), "delivery must be sha256 hex");
        let j = self.jobs.get_mut(&job).unwrap_or_else(|| env::panic_str("no such job"));
        require!(j.worker == caller, "only the worker delivers");
        require!(j.status == JobStatus::Hired, "job is not open");
        j.status = JobStatus::Delivered;
        j.delivery = Some(delivery.clone());
        Event::Delivered { campaign: j.campaign, job, delivery }.emit();
    }

    /// The buyer (or the referee, checking against the season reveal) settles a job:
    /// passed and delivered pays the worker; anything else refunds the treasury.
    /// Either way a receipt is logged.
    pub fn settle_job(&mut self, job: u64, passed: bool, note: String) {
        let caller = env::predecessor_account_id();
        require!(note.len() <= MAX_TEXT, "note too long");
        let j = self.jobs.get(&job).unwrap_or_else(|| env::panic_str("no such job")).clone();
        let referee = self.campaign(j.campaign).referee.clone();
        require!(caller == j.buyer || caller == referee, "only the buyer or the referee settles");
        require!(matches!(j.status, JobStatus::Hired | JobStatus::Delivered), "job already settled");
        let pay = passed && j.status == JobStatus::Delivered;
        if pay {
            let key = (j.campaign, j.worker.clone());
            let earned = self.earnings.get(&key).copied().unwrap_or(0);
            self.earnings.insert(key, earned + j.price);
        } else {
            self.campaign_mut(j.campaign).realms[j.realm as usize].treasury += j.price;
            // a refund gives the budget back too
            if let Some(p) = self.policies.get_mut(&(j.campaign, j.buyer.clone())) {
                p.spent_total = p.spent_total.saturating_sub(j.price);
                if p.season == j.season {
                    p.spent_season = p.spent_season.saturating_sub(j.price);
                }
            }
        }
        let jm = self.jobs.get_mut(&job).unwrap();
        jm.status = if pay { JobStatus::Paid } else { JobStatus::Refunded };
        jm.note = Some(note.clone());
        Event::Receipt {
            campaign: j.campaign,
            job,
            realm: j.realm,
            buyer: j.buyer,
            worker: j.worker,
            kind: j.kind,
            price: j.price,
            passed: pay,
            note,
        }
        .emit();
    }

    // ---------- views ----------

    pub fn get_owner(&self) -> &AccountId {
        &self.owner
    }

    pub fn is_referee(&self, account: AccountId) -> bool {
        self.referees.contains(&account)
    }

    pub fn get_campaign(&self, campaign: u64) -> Option<&Campaign> {
        self.campaigns.get(&campaign)
    }

    pub fn get_seal(&self, campaign: u64, season: u32, realm: u8) -> Option<&SealRecord> {
        self.seals.get(&(campaign, season, realm))
    }

    /// A realm's revealed orders for a season that hasn't settled yet.
    pub fn get_reveal(&self, campaign: u64, season: u32, realm: u8) -> Option<RevealedOrders> {
        env::storage_read(&season_key(REVEAL_PREFIX, campaign, season, realm)).map(|v| near_sdk::serde_json::from_slice(&v).unwrap())
    }

    /// Whether a realm's ruler forfeited its orders for a season that hasn't settled yet.
    pub fn get_forfeit(&self, campaign: u64, season: u32, realm: u8) -> bool {
        env::storage_has_key(&season_key(FORFEIT_PREFIX, campaign, season, realm))
    }

    pub fn get_policy(&self, campaign: u64, spender: AccountId) -> Option<&Policy> {
        self.policies.get(&(campaign, spender))
    }

    pub fn get_job(&self, job: u64) -> Option<&Job> {
        self.jobs.get(&job)
    }

    pub fn get_earnings(&self, campaign: u64, worker: AccountId) -> u64 {
        self.earnings.get(&(campaign, worker)).copied().unwrap_or(0)
    }

    // ---------- helpers ----------

    fn only_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
    }

    fn campaign(&self, id: u64) -> &Campaign {
        self.campaigns.get(&id).unwrap_or_else(|| env::panic_str("no such campaign"))
    }

    fn campaign_mut(&mut self, id: u64) -> &mut Campaign {
        self.campaigns.get_mut(&id).unwrap_or_else(|| env::panic_str("no such campaign"))
    }
}
