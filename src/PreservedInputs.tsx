import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

/**
 * Textarea that maintains local value state so that asynchronous parent store / React Flow
 * updates do not overwrite the active DOM element with stale state during typing.
 * This lets the browser manage cursor positioning and arrow-key navigation natively without jumping.
 */
export const PreservedTextarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function PreservedTextarea({ value, onChange, ...props }, forwardedRef) {
    const ref = useRef<HTMLTextAreaElement>(null);
    useImperativeHandle(forwardedRef, () => ref.current!);
    const [localValue, setLocalValue] = useState(value ?? '');

    useEffect(() => {
      setLocalValue(prev => (prev === (value ?? '') ? prev : (value ?? '')));
    }, [value]);

    return (
      <textarea
        {...props}
        ref={ref}
        value={localValue}
        onChange={e => {
          setLocalValue(e.target.value);
          onChange?.(e);
        }}
      />
    );
  }
);

/**
 * Input that maintains local value state so that asynchronous parent store / React Flow
 * updates do not overwrite the active DOM element with stale state during typing.
 */
export const PreservedInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function PreservedInput({ value, onChange, type, ...props }, forwardedRef) {
    const ref = useRef<HTMLInputElement>(null);
    useImperativeHandle(forwardedRef, () => ref.current!);
    const [localValue, setLocalValue] = useState(value ?? '');

    useEffect(() => {
      setLocalValue(prev => (prev === (value ?? '') ? prev : (value ?? '')));
    }, [value]);

    return (
      <input
        {...props}
        type={type}
        ref={ref}
        value={localValue}
        onChange={e => {
          setLocalValue(e.target.value);
          onChange?.(e);
        }}
      />
    );
  }
);
