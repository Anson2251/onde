try { clearTimeout(Symbol('x')); console.log('symbol ok'); } catch (e) { console.log('symbol threw', e.name); }
try { clearTimeout('2'); console.log('string ok'); } catch (e) { console.log('string threw', e.name); }
try { clearTimeout(undefined); console.log('undefined ok'); } catch (e) { console.log('undefined threw', e.name); }
