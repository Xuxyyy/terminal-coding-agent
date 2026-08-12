import test from 'node:test';

test('a rewind cuts the messages the model sees', {todo: 'v4 step 4'});

test('a rewind keeps everything before the cut', {todo: 'v4 step 4'});

test('a rewind does not forget approvals', {todo: 'v4 step 4'});

test('rewinding to the first message leaves only the system message', {todo: 'v4 step 4'});

test('a second rewind cuts again', {todo: 'v4 step 4'});

test('a rewind survives quitting and reopening', {todo: 'v4 step 4'});
