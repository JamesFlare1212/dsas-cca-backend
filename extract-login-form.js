import { chromium } from 'playwright';

async function extractLoginForm() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log('Navigating to login page...\n');
  await page.goto('https://engage.nkcswx.cn/Login.aspx');
  await page.waitForLoadState('networkidle');

  // Extract all form fields
  const formFields = await page.evaluate(() => {
    const form = document.querySelector('form');
    if (!form) return { error: 'No form found' };

    const fields = [];
    
    // Get all inputs from the form
    const inputs = form.querySelectorAll('input, select, textarea');
    inputs.forEach((input, index) => {
      fields.push({
        index,
        type: input.tagName,
        name: input.name || '(no name)',
        id: input.id || '(no id)',
        inputType: input.type || 'N/A',
        value: input.type === 'password' ? '[HIDDEN]' : (input.value || '(empty)'),
        placeholder: input.placeholder || '(none)',
        required: input.required ? 'yes' : 'no',
        autocomplete: input.autocomplete || '(none)'
      });
    });

    // Get form attributes
    const formAttrs = {
      action: form.action,
      method: form.method,
      enctype: form.enctype,
      target: form.target
    };

    return { formAttrs, fields };
  });

  if (formFields.error) {
    console.error(formFields.error);
    await browser.close();
    return;
  }

  console.log('='.repeat(70));
  console.log('FORM ATTRIBUTES');
  console.log('='.repeat(70));
  console.log(`Action:   ${formFields.formAttrs.action}`);
  console.log(`Method:   ${formFields.formAttrs.method}`);
  console.log(`Enctype:  ${formFields.formAttrs.enctype}`);
  console.log(`Target:   ${formFields.formAttrs.target || '(default)'}`);
  console.log('');

  console.log('='.repeat(70));
  console.log('ALL FORM FIELDS');
  console.log('='.repeat(70));
  console.log('');

  // Group fields by type
  const hiddenFields = formFields.fields.filter(f => f.inputType === 'hidden');
  const visibleFields = formFields.fields.filter(f => f.inputType !== 'hidden');

  // Show hidden fields first (critical for ASP.NET)
  if (hiddenFields.length > 0) {
    console.log('📦 HIDDEN FIELDS (critical for form submission):');
    console.log('-'.repeat(70));
    hiddenFields.forEach(field => {
      console.log(`  Name:    ${field.name}`);
      console.log(`  Value:   ${field.value.substring(0, 80)}${field.value.length > 80 ? '...' : ''}`);
      console.log(`  Length:  ${field.value.length} chars`);
      console.log('');
    });
  }

  // Show visible fields
  if (visibleFields.length > 0) {
    console.log('\n📝 VISIBLE FIELDS:');
    console.log('-'.repeat(70));
    visibleFields.forEach(field => {
      console.log(`  Name:         ${field.name}`);
      console.log(`  Type:         ${field.inputType}`);
      console.log(`  ID:           ${field.id}`);
      console.log(`  Placeholder:  ${field.placeholder}`);
      console.log(`  Required:     ${field.required}`);
      console.log(`  Autocomplete: ${field.autocomplete}`);
      console.log('');
    });
  }

  // Summary of field names
  console.log('='.repeat(70));
  console.log('FIELD NAME SUMMARY (for authentication payload):');
  console.log('='.repeat(70));
  formFields.fields.forEach(field => {
    const marker = field.inputType === 'hidden' ? '[HIDDEN]' : '[VISIBLE]';
    console.log(`  ${marker} ${field.name}`);
  });

  // Take a screenshot for visual reference
  await page.screenshot({ path: 'login-page-screenshot.png', fullPage: true });
  console.log('\n📸 Screenshot saved to: login-page-screenshot.png');

  await browser.close();
}

extractLoginForm().catch(console.error);
