//! The CPU-only crypto primitives: synchronous, loop-free, and keyed by numeric handles.
//!
//! The id→state table lives in `host_crypto`; JavaScript only ever holds the numeric handle.

use std::cell::RefCell;
use std::rc::Rc;

use ln_engine::js;
use ln_error::NodeError;

use crate::args;
use crate::host_crypto::{self, CryptoState};
use crate::host_error::throw_node_error_value;

use super::HostState;

pub(super) fn install<'js>(
    ctx: &js::Ctx<'js>,
    host: &js::Object<'js>,
    _state: &HostState,
) -> js::Result<()> {
    let crypto = js::Object::new(ctx.clone())?;
    let crypto_state = Rc::new(RefCell::new(CryptoState::new()));

    crypto.set(
        "randomBytes",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>, size: js::Value<'js>| -> js::Result<js::Value<'js>> {
                let size = args::number(Some(&size), "size")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                if !size.is_finite()
                    || !(0.0..=2_147_483_647.0).contains(&size)
                    || size.fract() != 0.0
                {
                    let error =
                        NodeError::out_of_range("size", ">= 0 && <= 2147483647", &size.to_string());
                    return Err(throw_node_error_value(&ctx, &error));
                }
                let bytes = ln_crypto::random_bytes(size as usize);
                Ok(js::TypedArray::<u8>::new(ctx.clone(), bytes)?.into_value())
            },
        )?,
    )?;

    crypto.set(
        "randomInt",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>, min: js::Value<'js>, max: js::Value<'js>| -> js::Result<f64> {
                let min = args::number(Some(&min), "min")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let max = args::number(Some(&max), "max")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let value = ln_crypto::random_int(min as i64, max as i64)
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                Ok(value as f64)
            },
        )?,
    )?;

    crypto.set(
        "randomUUID",
        js::Function::new(ctx.clone(), || -> js::Result<String> {
            Ok(ln_crypto::random_uuid())
        })?,
    )?;

    {
        let state = crypto_state.clone();
        crypto.set(
            "hashNew",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, name: js::Value<'js>| -> js::Result<u64> {
                    let name = args::string(Some(&name), "algorithm")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let algorithm = host_crypto::algorithm(&name)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    Ok(state.borrow_mut().hash_new(algorithm))
                },
            )?,
        )?;
    }

    {
        let state = crypto_state.clone();
        crypto.set(
            "hashUpdate",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      id: js::Value<'js>,
                      data: js::Value<'js>|
                      -> js::Result<()> {
                    let id = args::u64_value(Some(&id), "id")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let data = args::bytes(Some(&data), "data")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    state
                        .borrow_mut()
                        .hash_update(id, &data)
                        .map_err(|error| throw_node_error_value(&ctx, &error))
                },
            )?,
        )?;
    }

    {
        let state = crypto_state.clone();
        crypto.set(
            "hashDigest",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: js::Value<'js>| -> js::Result<js::Value<'js>> {
                    let id = args::u64_value(Some(&id), "id")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let bytes = state
                        .borrow_mut()
                        .hash_digest(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    Ok(js::TypedArray::<u8>::new(ctx.clone(), bytes)?.into_value())
                },
            )?,
        )?;
    }

    {
        let state = crypto_state.clone();
        crypto.set(
            "hashCopy",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: js::Value<'js>| -> js::Result<u64> {
                    let id = args::u64_value(Some(&id), "id")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    state
                        .borrow_mut()
                        .hash_copy(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))
                },
            )?,
        )?;
    }

    {
        let state = crypto_state.clone();
        crypto.set(
            "hmacNew",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      name: js::Value<'js>,
                      key: js::Value<'js>|
                      -> js::Result<u64> {
                    let name = args::string(Some(&name), "algorithm")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let algorithm = host_crypto::algorithm(&name)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let key = args::bytes(Some(&key), "key")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    Ok(state.borrow_mut().hmac_new(algorithm, &key))
                },
            )?,
        )?;
    }

    {
        let state = crypto_state.clone();
        crypto.set(
            "hmacUpdate",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>,
                      id: js::Value<'js>,
                      data: js::Value<'js>|
                      -> js::Result<()> {
                    let id = args::u64_value(Some(&id), "id")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let data = args::bytes(Some(&data), "data")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    state
                        .borrow_mut()
                        .hmac_update(id, &data)
                        .map_err(|error| throw_node_error_value(&ctx, &error))
                },
            )?,
        )?;
    }

    {
        let state = crypto_state.clone();
        crypto.set(
            "hmacDigest",
            js::Function::new(
                ctx.clone(),
                move |ctx: js::Ctx<'js>, id: js::Value<'js>| -> js::Result<js::Value<'js>> {
                    let id = args::u64_value(Some(&id), "id")
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    let bytes = state
                        .borrow_mut()
                        .hmac_digest(id)
                        .map_err(|error| throw_node_error_value(&ctx, &error))?;
                    Ok(js::TypedArray::<u8>::new(ctx.clone(), bytes)?.into_value())
                },
            )?,
        )?;
    }

    crypto.set(
        "timingSafeEqual",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>, a: js::Value<'js>, b: js::Value<'js>| -> js::Result<bool> {
                let a = args::bytes(Some(&a), "buf1")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let b = args::bytes(Some(&b), "buf2")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                ln_crypto::timing_safe_equal(&a, &b)
                    .map_err(|error| throw_node_error_value(&ctx, &error))
            },
        )?,
    )?;

    crypto.set(
        "hkdf",
        js::Function::new(
            ctx.clone(),
            |ctx: js::Ctx<'js>,
             name: js::Value<'js>,
             ikm: js::Value<'js>,
             salt: js::Value<'js>,
             info: js::Value<'js>,
             length: js::Value<'js>|
             -> js::Result<js::Value<'js>> {
                let name = args::string(Some(&name), "algorithm")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let algorithm = host_crypto::algorithm(&name)
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let ikm = args::bytes(Some(&ikm), "ikm")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let salt = args::bytes_or_empty(Some(&salt))
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let info = args::bytes_or_empty(Some(&info))
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let length = args::u64_value(Some(&length), "length")
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                let bytes = ln_crypto::hkdf(algorithm, &ikm, &salt, &info, length as usize)
                    .map_err(|error| throw_node_error_value(&ctx, &error))?;
                Ok(js::TypedArray::<u8>::new(ctx.clone(), bytes)?.into_value())
            },
        )?,
    )?;

    host.set("crypto", crypto)?;
    Ok(())
}
