import { stripUndefined } from './collections.mjs';
import { hashJson } from './hash.mjs';
import { cleanJsonValue, cleanTextValue } from './text-cleaning.mjs';

export function mapMetaobject(metaobject, shopId, syncedAt, definition = null) {
  const fields = metaobjectFieldsObject(metaobject);
  return stripUndefined({
    shop_id: shopId,
    shopify_metaobject_id: metaobject.id,
    metaobject_type: metaobject.type,
    definition_name: cleanTextValue(definition?.name),
    definition_fields: definition?.fieldDefinitions?.map(mapMetaobjectDefinitionField),
    handle: metaobject.handle,
    display_name: cleanTextValue(metaobject.displayName),
    status: null,
    fields,
    content_hash: hashJson(fields),
    synced_at: syncedAt,
    raw_shopify_payload: stripUndefined({
      id: metaobject.id,
      type: metaobject.type,
      handle: metaobject.handle,
      displayName: metaobject.displayName,
      updatedAt: metaobject.updatedAt,
      fields: metaobject.fields
    })
  });
}

export function metaobjectFieldsObject(metaobject) {
  const fields = {};
  for (const field of metaobject.fields || []) {
    fields[field.key] = stripUndefined({
      type: field.type,
      value: cleanTextValue(field.value),
      json_value: cleanJsonValue(field.jsonValue)
    });
  }
  return fields;
}

function mapMetaobjectDefinitionField(field) {
  return stripUndefined({
    key: field.key,
    name: cleanTextValue(field.name),
    required: field.required,
    type: field.type?.name
  });
}
