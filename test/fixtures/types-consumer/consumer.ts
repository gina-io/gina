/**
 * Consumer fixture — compiled by `script/check_types_consumer.js` (and, via
 * the wrapper test, by the regular suite).
 *
 * The point of this file is to typecheck REAL consumer usage of the
 * published declarations, resolving `gina` BY PACKAGE NAME through the
 * exports map (`moduleResolution: node16`). A by-path probe is structurally
 * blind to a missing `export =` on the main entry — this fixture is not.
 *
 * The `@ts-expect-error` directives at the bottom are live tripwires: if a
 * regression re-introduces the member they suppress, the directive goes
 * UNUSED and the compile fails with TS2578. The fixture is its own subtract
 * control.
 */

import gina = require('gina');                 // the primary CJS consumer form
import type {
    GinaRequest,
    SuperController,
    SuperControllerConstructor,
    DtoBuilder,
    RouteParam,
    Gna
} from 'gina';
import ginaBarrel = require('gina/gna');       // the constructors live HERE

function expectType<T>(value: T): T { return value; }

/** `expectType` cannot catch an `any` (assignable to everything) — this can. */
type IsAny<T> = 0 extends (1 & T) ? true : false;

// ─── D1: the module IS a value ───────────────────────────────────────────────

expectType<Gna>(gina);
expectType<() => void>(gina.start);
gina.onInitialize(function (event, instance, middleware) {
    // D12: getConfig is `undefined` until models load — the type demands narrowing.
    if (gina.getConfig) {
        const conf = gina.getConfig('settings');
        void conf;
    }
    void event; void instance; void middleware;
});

// ─── D10: `gina.dto` is the documented DTO entry point ──────────────────────

const CreateUser = gina.dto.object({
    email:  gina.dto.string().email().required(),
    age:    gina.dto.integer().min(18),
    role:   gina.dto.enum(['admin', 'user']).required(),
    secret: gina.dto.string().exclude()
}, 'CreateUser');
expectType<object>(CreateUser.toJsonSchema('draft-07'));
expectType<DtoBuilder>(gina.lib.dto);

// ─── D7: lib registry members ────────────────────────────────────────────────

expectType<any>(gina.lib.i18n);
expectType<any>(gina.lib.secrets);
expectType<any>(gina.lib.metrics);
expectType<any>(gina.lib.job);

// ─── The #DTO3 payoff: GinaRequest<TDto> ─────────────────────────────────────

interface CreateUserProjected { email: string; age: number; role: 'admin' | 'user'; }
declare const req: GinaRequest<CreateUserProjected>;

expectType<string | undefined>(req.dto?.email);
expectType<number | undefined>(req.dto?.age);
// The intersection with Record<string, any> must PRESERVE declared field
// types (must NOT collapse to `any`) while undeclared keys stay reachable:
const _postEmailNotAny: IsAny<NonNullable<typeof req.post>['email']> extends false ? true : never = true;
const _dtoEmailNotAny: IsAny<NonNullable<typeof req.dto>['email']> extends false ? true : never = true;
void _postEmailNotAny; void _dtoEmailNotAny;
const tenant = req.post ? req.post.tenant : undefined;   // undeclared key (URL param) allowed
void tenant;

// ─── RouteParam carries the DTO wiring ───────────────────────────────────────

const p: RouteParam = { control: 'createUser', dto: 'CreateUser', responseDto: 'UserView', tenant: ':tenant' };
void p;

// ─── D9: the controller surface ──────────────────────────────────────────────

declare const self: SuperController;
expectType<string>(self.t('greeting'));
expectType<string>(self.t.icu('cart.items', { count: 2 }));
expectType<boolean>(self.emitEvent('order.created', { id: 1 }));
expectType<string>(self.startJob(() => 42));
self.jobStatus('abc', (err, record) => { void err; void record; });
expectType<string>(self.inferAsync([{ role: 'user', content: 'hi' }]));
expectType<SuperController>(self.sendTrailers({ 'server-timing': 'edge;dur=1' }));
self.setTemplate('errors/404');
expectType<number>(self.cache.invalidateByEvent('order.created'));
expectType<number>(self.cache.clear());
self.once('query#complete', () => {});         // the INSTANCE is an EventEmitter

// ─── D3: the constructor VALUES live on gina/gna ─────────────────────────────

expectType<SuperControllerConstructor>(ginaBarrel.SuperController);
const inst = ginaBarrel.SuperController.createTestInstance({ req: {}, res: {}, next: () => {} });
expectType<SuperController>(inst);
const inst2 = new ginaBarrel.SuperController({});
void inst2;
const ent = new ginaBarrel.EntitySuper(null, 'fixture');
expectType<string>(ent.bundle);

// ─── D2: the JSON augmentation lands ─────────────────────────────────────────

expectType<{ a: number }>(JSON.clone({ a: 1 }));
expectType<string>(JSON.escape('x'));

// ─── D8: injected globals are declared ───────────────────────────────────────

expectType<object>(merge({ a: 1 }, { b: 2 }));
expectType<string>(safeDecodeURI('/a%2Fb'));
expectType<string>(safeDecodeURIComponent('50%off'));
nestBracketNotationKey({}, ['item', '0', 'id'], 0, 7);
joinContext({ x: 1 });
log('fixture');
defineDefault({ MY_FLAG: '1' });
expectType<number>(__line);
expectType<string[]>(getProtected());

// ─── D6: setPath accepts the object form the framework itself uses ──────────

setPath('gina', { core: '/tmp/core' });
setPath('project', '/tmp/project');

// ─── Array augmentation (control: `declare global` block applies) ───────────

expectType<number[]>([1, 2, 3].clone());

// ═══ NEGATIVE TRIPWIRES ══════════════════════════════════════════════════════

// @ts-expect-error D4 — the module object is NOT an EventEmitter (`gina.on` does not exist)
gina.on('ready', () => {});

// @ts-expect-error D4 — no `once` either
gina.once('ready', () => {});

// @ts-expect-error D3 — SuperController is NOT a value on the main entry
new gina.SuperController();

// @ts-expect-error D5 — String.prototype.ltrim was never real
'  x '.ltrim();

// @ts-expect-error D5 — String.prototype.gtrim was never real
'  x '.gtrim();

export {};
